// import moment
import { Subscription } from "@supabase/supabase-js";
import FileSystemSync from "file_system_sync";
import {
	Notice,
	Plugin,
	TFile,
	MarkdownView,
} from "obsidian";
import SupabaseSync from "supabase_sync";
import {
	FleetingNotesSettings,
	FleetingNotesSettingsTab,
	DEFAULT_SETTINGS,
} from "./settings";

import {
	throwError,
	openInputModal,
} from "./utils";

export interface ObsidianNote {
	file: TFile;
	frontmatter: any;
	content: string;
}

export interface Note {
	id: string;
	title?: string;
	content?: string;
	created_at?: string;
	modified_at?: string;
	source?: string;
	deleted?: boolean;
  encrypted?: boolean;
}

export default class FleetingNotesPlugin extends Plugin {
	settings: FleetingNotesSettings;
  supabaseAuthSubscription: Subscription | undefined;
  fileSystemSync: FileSystemSync;
  supabaseSync: SupabaseSync;

	async onload() {
		await this.loadSettings();
		// This forces fleeting notes to sync with obsidian
		this.addCommand({
			id: "sync-fleeting-notes",
			name: "Sync Notes with Fleeting Notes",
			callback: async () => {
				const isSuccess = await this.syncFleetingNotes();
        if (isSuccess) {
          new Notice("Fleeting Notes Sync Success")
        }
			},
		});

		this.addCommand({
			id: "insert-notes-containing",
			name: "Insert All Notes Containing Specific Text",
			callback: async () => {
				openInputModal(
					"Insert All Notes Containing:",
					[
						{
							label: "Text",
							value: "text",
						},
					],
					"Search",
					(result) => {
						this.embedNotesWithText(result.text);
					}
				);
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new FleetingNotesSettingsTab(this.app, this));

		// syncs on startup
		if (this.settings.sync_on_startup) {
			// Files might not be loaded yet
			this.app.workspace.onLayoutReady(() => {
				this.autoSync();
			});
		}
    // listen for auth state changes
    const { data } = await SupabaseSync.onAuthStateChange(this.reloginOnSignout);
    this.supabaseAuthSubscription = data.subscription;

    // init filesystem sync
    this.fileSystemSync = new FileSystemSync(this.app.vault, this.settings);
    await this.fileSystemSync.init()

    /// init supabase sync
    this.supabaseSync = new SupabaseSync(this.settings);

    // intialize realtime
    this.initRealtime(this.settings.sync_type)
	}
	disableAutoSync() {
		if (this.settings.sync_interval) {
			clearInterval(this.settings.sync_interval);
		}
	}
  
  initRealtime(sync_type: string) {
    if (sync_type === 'realtime-two-way') {
      this.fileSystemSync.onNoteChange(this.supabaseSync.updateNote);
      this.supabaseSync.onNoteChange((note) => this.fileSystemSync.upsertNotes([note]));
    } else if (sync_type === 'realtime-one-way') {
      this.fileSystemSync.offNoteChange();
      this.supabaseSync.onNoteChange((note) => this.fileSystemSync.upsertNotes([note]));
    } else {
      this.fileSystemSync.offNoteChange();
      this.supabaseSync.removeAllChannels();
    }
  }

  async reloginOnSignout(event: string) {
    if (event == "SIGNED_OUT") {
      if (this.settings.email && this.settings.password) {
        try {
          await SupabaseSync.loginSupabase(this.settings.email, this.settings.password);
        } catch (e) {
          this.signOutUser();
        }
      } else {
        this.signOutUser();
      }
    }
  }

  isUserSignedIn() {
    return this.settings.firebaseId || this.settings.supabaseId
  }

  signOutUser() {
    this.settings.supabaseId = undefined;
    this.settings.email = undefined;
    this.settings.password = undefined;
    this.settings.firebaseId = undefined;
    this.saveSettings();
  }

	autoSync(syncIntervalMin: number = 30) {
		const syncIntervalMs = syncIntervalMin * 60 * 1000;
		this.disableAutoSync();
		this.syncFleetingNotes();
		this.settings.sync_interval = setInterval(
			this.syncFleetingNotes.bind(this),
			syncIntervalMs
		);
	}

	onunload() {
		this.disableAutoSync();
    this.supabaseAuthSubscription?.unsubscribe();
    this.fileSystemSync.offNoteChange();
    this.supabaseSync.removeAllChannels();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async embedNotesWithText(text: string) {
		let sameSourceNotes: ObsidianNote[] = [];
		try {
			sameSourceNotes = await this.getNotesWithText(text);
			if (sameSourceNotes.length === 0) {
				new Notice(`No notes with text "${text}" found`);
				return;
			}
			const template = "![[${linkText}]]\n\n";
			const sameSourceNoteString = this.embedNotesToString(
				sameSourceNotes,
				this.app.workspace.getActiveFile().path,
				template
			);
			this.appendStringToActiveFile(sameSourceNoteString);
			new Notice(`Notes with text "${text}" inserted`);
		} catch (e) {
			if (typeof e === "string") {
				new Notice(e);
			} else {
				console.error(e);
				new Notice(`Failed to embed notes with text: "${text}"`);
			}
		}
	}

	// syncs changes between obsidian and fleeting notes
	async syncFleetingNotes() {
    if (!this.isUserSignedIn()) {
      new Notice("No login credentials found")
      return false;
    }
		try {
			if (this.settings.sync_type === "two-way") {
				await this.pushFleetingNotes();
			}
			// pull fleeting notes
			let notes = await this.supabaseSync.getAllNotes();
			notes = notes.filter((note: Note) => !note.deleted);
      const deleteAfterSync = this.settings.sync_type == "one-way-delete"
      await this.fileSystemSync.upsertNotes(notes, deleteAfterSync);
			if (deleteAfterSync) {
        await this.deleteFleetingNotes(notes);
			}
			this.settings.last_sync_time = new Date();
      return true;
		} catch (e) {
			if (typeof e === "string") {
				new Notice(e);
			} else {
				console.error(e);
				new Notice("Fleeing Notes sync failed - please check settings");
			}
		}
    return false;
	}

	async appendStringToActiveFile(content: string) {
		const active_view =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = active_view.editor;
		const doc = editor.getDoc();
		doc.replaceSelection(content);
	}

	// writes fleeting notes to firebase
	async pushFleetingNotes() {
		try {
			var modifiedNotes = await this.getUpdatedLocalNotes();
			var formattedNotes = await Promise.all(
				modifiedNotes.map(FileSystemSync.parseObsidianNote)
			);
			if (formattedNotes.length > 0) {
				await this.supabaseSync.updateNotes(formattedNotes);
				this.settings.last_sync_time = new Date();
			}
		} catch (e) {
			throwError(
				e,
				"Failed to push notes from Obsidian to Fleeting Notes"
			);
		}
	}

	async deleteFleetingNotes(notes: Note[]) {
		try {
			var notesToDelete = await Promise.all(
				notes.map(async (note) => {
					return {
						id: note.id,
						deleted: true,
					};
				})
			);
			if (notesToDelete.length > 0) {
				await this.supabaseSync.updateNotes(notesToDelete);
			}
		} catch (e) {
			throwError(e, "Failed to delete notes from Fleeting Notes");
		}
	}

	// returns a list of files that have been modified since the last sync
	async getUpdatedLocalNotes() {
		var existingNotes = await this.fileSystemSync.getAllNotes();
		var modifiedNotes = existingNotes.filter((note) => {
			const { file, frontmatter } = note;
			const isContentModified =
				new Date(file.stat.mtime) >
				new Date(this.settings.last_sync_time);
			const isTitleChanged =
				frontmatter.title && frontmatter.title !== file.basename;
			return isContentModified || isTitleChanged;
		});
		return modifiedNotes;
	}

	embedNotesToString(
		notes: Array<ObsidianNote>,
		sourcePath: string,
		template: string
	) {
		let embedNotesString = "";
		notes.forEach((note) => {
			const linkText = this.app.metadataCache.fileToLinktext(
				note.file,
				sourcePath
			);
			embedNotesString += template.replace("${linkText}", linkText);
		});
		return embedNotesString;
	}

	async getNotesWithText(text: string) {
		var existingNotes = await this.fileSystemSync.getAllNotes();
		const textInMetaData = (note: ObsidianNote) => {
			let hasSource = false;
			if (note.frontmatter) {
				Object.values(note.frontmatter).forEach(
					(fm: string | number | boolean) => {
						if (fm.toString().includes(text)) {
							hasSource = true;
						}
					}
				);
			}
			return hasSource;
		};

		const hasTextInContent = (note: ObsidianNote) => {
			return note.content?.includes(text);
		};

		const notesWithSameSource = existingNotes.filter((note) => {
			return textInMetaData(note) || hasTextInContent(note);
		});
		return notesWithSameSource;
	}

	getAllLinks() {
		const unresolvedLinks = this.app.metadataCache.unresolvedLinks;
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const allLinksSet = new Set();
		for (const [file, links] of Object.entries(resolvedLinks)) {
			const addLinkToSet = (link: string) => {
				const cleanedLink = link.split("/").at(-1).replace(/\.md$/, "");
				allLinksSet.add(cleanedLink);
			};
			addLinkToSet(file);
			Object.keys(links).forEach(addLinkToSet);
			Object.keys(unresolvedLinks[file]).forEach(addLinkToSet);
		}
		return [...allLinksSet];
	}
}
