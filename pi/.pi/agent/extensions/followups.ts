import {
	DynamicBorder,
	ExtensionEditorComponent,
	getSelectListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type FollowUpMessage,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	Text,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

function cloneMessage(message: FollowUpMessage): FollowUpMessage {
	return {
		text: message.text,
		images: message.images ? [...message.images] : undefined,
	};
}

function previewText(text: string): string {
	const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return firstLine || "(empty)";
}

class FollowUpEditorComponent extends Container implements Focusable {
	private drafts: FollowUpMessage[];
	private selectedIndex = 0;
	private list?: SelectList;
	private editor?: ExtensionEditorComponent;
	private deleteIndex?: number;
	private _focused = false;
	private finished = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		messages: FollowUpMessage[],
		private readonly onDone: (messages: FollowUpMessage[]) => void,
	) {
		super();
		this.drafts = messages.map(cloneMessage);
		this.rebuildList();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.editor) this.editor.focused = value;
	}

	handleInput(data: string): void {
		if (this.finished) return;

		if (this.editor) {
			this.editor.handleInput(data);
			return;
		}

		if (this.deleteIndex !== undefined) {
			if (data.toLowerCase() === "y") {
				this.drafts.splice(this.deleteIndex, 1);
				this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.drafts.length - 1));
				this.deleteIndex = undefined;
				this.rebuildList();
				this.tui.requestRender();
				return;
			}
			if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) {
				this.deleteIndex = undefined;
				this.rebuildList();
				this.tui.requestRender();
			}
			return;
		}

		if (data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.beginEdit();
			return;
		}
		if (data === "d") {
			this.beginDelete();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.finish();
			return;
		}

		this.list?.handleInput(data);
		this.syncSelectionFromList();
		this.tui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.list?.invalidate();
	}

	dispose(): void {
		this.finished = true;
	}

	private moveSelection(delta: number): void {
		if (this.drafts.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.drafts.length - 1, this.selectedIndex + delta));
		this.list?.setSelectedIndex(this.selectedIndex);
		this.invalidate();
		this.tui.requestRender();
	}

	private syncSelectionFromList(): void {
		const value = this.list?.getSelectedItem()?.value;
		const index = value === undefined ? undefined : Number(value);
		if (index !== undefined && Number.isInteger(index)) {
			this.selectedIndex = Math.max(0, Math.min(this.drafts.length - 1, index));
		}
	}

	private beginEdit(): void {
		if (this.drafts.length === 0) return;
		this.syncSelectionFromList();
		const index = this.selectedIndex;
		const draft = this.drafts[index];
		this.clear();
		this.editor = new ExtensionEditorComponent(
			this.tui,
			this.keybindings,
			`Edit follow-up ${index + 1}`,
			draft.text,
			(text) => {
				this.drafts[index] = { ...draft, text };
				this.editor = undefined;
				this.rebuildList();
				this.tui.requestRender();
			},
			() => {
				this.editor = undefined;
				this.rebuildList();
				this.tui.requestRender();
			},
			{ paddingX: 1 },
		);
		this.addChild(this.editor);
		this.editor.focused = this._focused;
		this.tui.requestRender();
	}

	private beginDelete(): void {
		if (this.drafts.length === 0) return;
		this.syncSelectionFromList();
		this.deleteIndex = this.selectedIndex;
		this.rebuildList();
		this.tui.requestRender();
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.onDone(this.drafts.map(cloneMessage));
	}

	private rebuildList(): void {
		this.clear();
		this.list = undefined;
		this.editor = undefined;

		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(`Follow-ups (${this.drafts.length})`)), 1, 0));

		if (this.drafts.length === 0) {
			this.addChild(new Text(this.theme.fg("muted", "No follow-up messages remain."), 1, 0));
		} else {
			const items = this.drafts.map((message, index) => ({
				value: String(index),
				label: `${index + 1}. ${previewText(message.text)}`,
				description: [
					`${message.text.split(/\r?\n/).length} line${message.text.includes("\n") ? "s" : ""}`,
					message.images?.length ? `${message.images.length} image${message.images.length === 1 ? "" : "s"}` : "",
				].filter(Boolean).join(" • "),
			}));
			this.list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
			this.list.setSelectedIndex(this.selectedIndex);
			this.addChild(this.list);
		}

		if (this.deleteIndex !== undefined) {
			this.addChild(new Text(
				this.theme.fg("warning", `Delete follow-up ${this.deleteIndex + 1}? Press y to confirm or n to cancel.`),
				1,
				0,
			));
		} else {
			this.addChild(new Text(
				this.theme.fg("dim", "j/k move • enter edit • d delete • esc close (edits auto-save)"),
				1,
				0,
			));
		}
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
	}
}

async function showFollowUpEditor(
	ctx: ExtensionCommandContext,
	messages: FollowUpMessage[],
): Promise<FollowUpMessage[] | undefined> {
	return ctx.ui.custom<FollowUpMessage[] | undefined>((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value: FollowUpMessage[] | undefined) => void) =>
		new FollowUpEditorComponent(tui, theme, keybindings, messages, done),
	);
}

export default function followupsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("followups", {
		description: "Browse and edit queued follow-up messages",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /followups", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/followups requires interactive mode", "error");
				return;
			}

			const result = await ctx.editFollowUpMessages(async (messages) => {
				return showFollowUpEditor(ctx, messages);
			});
			if (result === "empty") {
				ctx.ui.notify("No queued follow-up messages", "info");
			} else if (result === "saved") {
				ctx.ui.notify("Follow-up queue updated", "info");
			}
		},
	});
}
