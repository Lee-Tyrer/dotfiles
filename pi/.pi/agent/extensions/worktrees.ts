/**
 * Adds a /worktrees TUI for creating, opening, listing, and removing Git worktrees.
 */
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	Text,
	type SelectItem,
} from "@earendil-works/pi-tui";

type Action = "new" | "open" | "list" | "remove";

type Worktree = {
	path: string;
	head?: string;
	branch?: string;
	bare: boolean;
	detached: boolean;
	locked?: string;
	prunable?: string;
};

const MENU: Array<{ key: string; action: Action; label: string; description: string }> = [
	{ key: "n", action: "new", label: "New worktree", description: "Create a branch and workspace" },
	{ key: "o", action: "open", label: "Open worktree", description: "Open an existing workspace" },
	{ key: "l", action: "list", label: "List worktrees", description: "Inspect paths, branches, and state" },
	{ key: "r", action: "remove", label: "Remove worktree", description: "Choose a workspace to remove" },
];

function branchName(worktree: Worktree): string {
	return worktree.branch?.replace(/^refs\/heads\//, "") ?? (worktree.detached ? `(detached ${worktree.head?.slice(0, 8) ?? ""})` : "(unknown)");
}

function parseWorktrees(output: string): Worktree[] {
	return output
		.trim()
		.split(/\n\s*\n/)
		.filter(Boolean)
		.map((record) => {
			const result: Worktree = { path: "", bare: false, detached: false };
			for (const line of record.split("\n")) {
				const [key, ...rest] = line.split(" ");
				const value = rest.join(" ");
				if (key === "worktree") result.path = value;
				else if (key === "HEAD") result.head = value;
				else if (key === "branch") result.branch = value;
				else if (key === "bare") result.bare = true;
				else if (key === "detached") result.detached = true;
				else if (key === "locked") result.locked = value || "locked";
				else if (key === "prunable") result.prunable = value || "prunable";
			}
			return result;
		})
		.filter((item) => item.path);
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	return pi.exec("git", ["-C", cwd, ...args], { timeout: 15_000 });
}

async function getWorktrees(pi: ExtensionAPI, cwd: string): Promise<Worktree[]> {
	const result = await git(pi, cwd, ["worktree", "list", "--porcelain"]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Not inside a Git repository");
	return parseWorktrees(result.stdout);
}

function menuLines(theme: ExtensionCommandContext["ui"]["theme"]): string[] {
	const lines = [
		theme.fg("accent", theme.bold("Worktrees")),
		"",
		...MENU.map((item) =>
			`  ${theme.fg("accent", theme.bold(item.key))}  ${theme.fg("text", item.label)}  ${theme.fg("dim", item.description)}`,
		),
		"",
		theme.fg("dim", "Press a key to choose · esc close"),
	];
	return lines;
}

async function chooseAction(ctx: ExtensionCommandContext): Promise<Action | null> {
	return ctx.ui.custom<Action | null>((tui, theme, _keybindings, done) => {
		const component = {
			render(width: number) {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(menuLines(theme).join("\n"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return container.render(width);
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) return done(null);
				const match = MENU.find((item) => data.toLowerCase() === item.key);
				if (match) done(match.action);
				tui.requestRender();
			},
			invalidate() {},
		};
		return component;
	});
}

async function chooseWorktree(
	ctx: ExtensionCommandContext,
	title: string,
	worktrees: Worktree[],
	options: { detailed?: boolean } = {},
): Promise<Worktree | null> {
	if (worktrees.length === 0) {
		ctx.ui.notify("No matching worktrees.", "info");
		return null;
	}
	const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
	const items: SelectItem[] = worktrees.map((worktree) => {
		const flags = [worktree.locked && "locked", worktree.prunable && "prunable", worktree.detached && "detached"].filter(Boolean);
		return {
			value: worktree.path,
			label: branchName(worktree),
			description: options.detailed
				? `${worktree.path}${flags.length ? ` · ${flags.join(", ")}` : ""}`
				: path.basename(worktree.path),
		};
	});

	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		let searching = false;
		let filter = "";
		const help = new Text(theme.fg("dim", "j/k or ↑/↓ navigate · g/G first/last · / search · enter select · esc back"), 1, 0);
		container.addChild(help);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		const updateFilter = () => {
			list.setFilter(filter);
			help.setText(theme.fg("accent", `Search: ${filter}▏`) + theme.fg("dim", "  · esc clear"));
		};
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (searching) {
					if (matchesKey(data, Key.escape)) {
						searching = false;
						filter = "";
						list.setFilter("");
						help.setText(theme.fg("dim", "j/k or ↑/↓ navigate · g/G first/last · / search · enter select · esc back"));
					} else if (matchesKey(data, Key.backspace)) {
						filter = filter.slice(0, -1);
						updateFilter();
					} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
						list.handleInput(data);
					} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
						filter += data;
						updateFilter();
					}
				} else if (data === "/") {
					searching = true;
					updateFilter();
				} else if (data === "j") list.handleInput("\x1b[B");
				else if (data === "k") list.handleInput("\x1b[A");
				else if (data === "g") list.setSelectedIndex(0);
				else if (data === "G") list.setSelectedIndex(items.length - 1);
				else list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return selected ? byPath.get(selected) ?? null : null;
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

const NVIM_ARGS = [
	".",
	"-c",
	"lua vim.defer_fn(function() vim.cmd('silent! enew') end, 250)",
];

function spawnDetached(command: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
		child.once("error", reject);
	});
}

async function openWorktree(_pi: ExtensionAPI, ctx: ExtensionCommandContext, worktree: Worktree): Promise<void> {
	const terminal = (process.env.TERM_PROGRAM ?? "").toLowerCase();
	if (terminal.includes("alacritty") || process.env.ALACRITTY_WINDOW_ID) {
		await spawnDetached("alacritty", ["--working-directory", worktree.path, "-e", "nvim", ...NVIM_ARGS], worktree.path);
		ctx.ui.notify(`Opened ${branchName(worktree)} in a new Alacritty + Neovim instance`, "info");
		return;
	}

	if (terminal.includes("wezterm")) {
		await spawnDetached("wezterm", ["start", "--cwd", worktree.path, "--", "nvim", ...NVIM_ARGS], worktree.path);
		ctx.ui.notify(`Opened ${branchName(worktree)} in a new Neovim window`, "info");
		return;
	}
	if (terminal.includes("kitty")) {
		await spawnDetached("kitty", ["--directory", worktree.path, "nvim", ...NVIM_ARGS], worktree.path);
		ctx.ui.notify(`Opened ${branchName(worktree)} in a new Neovim window`, "info");
		return;
	}
	if (terminal.includes("ghostty")) {
		await spawnDetached("ghostty", [`--working-directory=${worktree.path}`, "-e", "nvim", ...NVIM_ARGS], worktree.path);
		ctx.ui.notify(`Opened ${branchName(worktree)} in a new Neovim window`, "info");
		return;
	}

	// Pi launched by Sidekick may not inherit Alacritty's identifying variables,
	// so use the configured local default before giving up.
	await spawnDetached("alacritty", ["--working-directory", worktree.path, "-e", "nvim", ...NVIM_ARGS], worktree.path);
	ctx.ui.notify(`Opened ${branchName(worktree)} in a new Alacritty + Neovim instance`, "info");
}

async function createWorktree(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<Worktree | null> {
	const branch = (await ctx.ui.input("New worktree", "Branch name"))?.trim();
	if (!branch) return null;
	const validBranch = await pi.exec("git", ["check-ref-format", "--branch", branch], { timeout: 5_000 });
	if (validBranch.code !== 0) {
		ctx.ui.notify(validBranch.stderr.trim() || "That is not a valid Git branch name.", "error");
		return null;
	}
	const worktrees = await getWorktrees(pi, ctx.cwd);
	const main = worktrees[0];
	if (!main) throw new Error("Could not determine the main worktree");
	const destination = path.join(os.homedir(), ".worktrees", path.basename(main.path), safeName(branch));
	const exists = await git(pi, main.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	const args = exists.code === 0
		? ["worktree", "add", destination, branch]
		: ["worktree", "add", "-b", branch, destination];
	const result = await git(pi, main.path, args);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not create worktree");
	const created = (await getWorktrees(pi, main.path)).find((item) => path.resolve(item.path) === path.resolve(destination)) ?? null;
	if (created) ctx.ui.notify(`Created ${branchName(created)} at ${created.path}`, "info");
	return created;
}

async function removeWorktree(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const worktrees = await getWorktrees(pi, ctx.cwd);
	const mainPath = path.resolve(worktrees[0]?.path ?? ctx.cwd);
	const activeRootResult = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
	const activeRoot = path.resolve(activeRootResult.code === 0 ? activeRootResult.stdout.trim() : ctx.cwd);
	const removable = worktrees.filter((item) => !item.bare && path.resolve(item.path) !== mainPath && path.resolve(item.path) !== activeRoot);
	const selected = await chooseWorktree(ctx, "Remove a worktree", removable, { detailed: true });
	if (!selected) return;
	if (selected.locked) {
		ctx.ui.notify(`Cannot remove a locked worktree: ${selected.locked}`, "warning");
		return;
	}
	const status = await git(pi, selected.path, ["status", "--porcelain"]);
	const dirty = status.code === 0 && status.stdout.trim().length > 0;
	const confirmed = await ctx.ui.confirm(
		dirty ? "Remove dirty worktree?" : "Remove worktree?",
		`${branchName(selected)}\n${selected.path}${dirty ? "\n\nUncommitted changes will be deleted." : ""}`,
	);
	if (!confirmed) return;
	const result = await git(pi, mainPath, ["worktree", "remove", ...(dirty ? ["--force"] : []), selected.path]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not remove worktree");
	await git(pi, mainPath, ["worktree", "prune"]);
	ctx.ui.notify(`Removed ${branchName(selected)}`, "info");
}

export default function worktreesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("worktrees", {
		description: "Create, open, inspect, and remove Git worktrees",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The worktree selector requires interactive TUI mode.", "warning");
				return;
			}
			await ctx.waitForIdle();
			const action = await chooseAction(ctx);
			if (!action) return;
			try {
				if (action === "new") {
					await createWorktree(pi, ctx);
				} else if (action === "remove") {
					await removeWorktree(pi, ctx);
				} else {
					const worktrees = await getWorktrees(pi, ctx.cwd);
					const selected = await chooseWorktree(
						ctx,
						action === "list" ? "Worktrees" : "Open a worktree",
						worktrees.filter((item) => !item.bare),
						{ detailed: action === "list" },
					);
					if (selected) await openWorktree(pi, ctx, selected);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
