/**
 * /diff opens the latest prompt's recorded edit diffs in Neovim.
 * Uses tool-result details.diff, including history from before this extension loaded.
 * Write and Bash changes are excluded. No repository or filesystem snapshot is used.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const NESTED_DIFF_ENTRY = "prompt-diff:nested-edit";

interface DiffChange {
	toolCallId: string;
	path: string;
	diff: string;
}

interface PromptDiff {
	prompt: string;
	timestamp: string;
	changes: DiffChange[];
	omittedWrites: number;
	missingEdits: number;
}

function recordedDiff(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" ? diff : undefined;
}

export function collectLatestPromptDiff(entries: readonly SessionEntry[]): PromptDiff | undefined {
	let start = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") {
			start = index;
			break;
		}
	}
	const prompt = entries[start];
	if (!prompt || prompt.type !== "message" || prompt.message.role !== "user") return undefined;

	const content = prompt.message.content;
	const result: PromptDiff = {
		prompt: typeof content === "string"
			? content
			: content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
		timestamp: prompt.timestamp,
		changes: [],
		omittedWrites: 0,
		missingEdits: 0,
	};
	const paths = new Map<string, string>();
	const seen = new Set<string>();
	const add = (change: DiffChange) => {
		if (!change.diff || seen.has(change.toolCallId)) return;
		seen.add(change.toolCallId);
		result.changes.push(change);
	};

	// Read the raw active branch, so reloads, compaction, and forks preserve scope.
	for (const entry of entries.slice(start + 1)) {
		if (entry.type === "custom" && entry.customType === NESTED_DIFF_ENTRY) {
			if (typeof entry.data !== "object" || entry.data === null) continue;
			const change = entry.data as Partial<DiffChange>;
			if (typeof change.toolCallId === "string" && typeof change.path === "string" && typeof change.diff === "string") {
				add(change as DiffChange);
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall" && typeof part.arguments?.path === "string") {
					paths.set(part.id, part.arguments.path);
				}
			}
		} else if (message.role === "toolResult" && !message.isError) {
			if (message.toolName === "write") result.omittedWrites++;
			if (message.toolName !== "edit") continue;
			const diff = recordedDiff(message.details);
			if (diff === undefined) {
				result.missingEdits++;
				continue;
			}
			add({ toolCallId: message.toolCallId, path: paths.get(message.toolCallId) ?? "(path unavailable)", diff });
		}
	}
	return result;
}

export default function diffExtension(pi: ExtensionAPI): void {
	// Nested results are not stored in the normal transcript. Save only those diffs.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" || event.isError || !event.parentToolCallId) return;
		const diff = recordedDiff(event.details);
		if (!diff) return;
		pi.appendEntry(NESTED_DIFF_ENTRY, {
			toolCallId: event.toolCallId,
			path: typeof event.input.path === "string" ? event.input.path : "(path unavailable)",
			diff,
		} satisfies DiffChange);
	});

	pi.registerCommand("diff", {
		description: "Review the latest prompt's recorded edit diffs in Neovim",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /diff", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/diff requires interactive Pi.", "warning");
				return;
			}
			await ctx.waitForIdle();

			let directory: string | undefined;
			try {
				const review = collectLatestPromptDiff(ctx.sessionManager.getBranch());
				if (!review?.changes.length) {
					ctx.ui.notify("No recorded edit diffs for the latest prompt. Write and Bash changes are excluded.", "info");
					return;
				}
				directory = await mkdtemp(join(tmpdir(), "pi-prompt-diff-"));
				const payload = join(directory, "review.json");
				await writeFile(payload, JSON.stringify(review), { mode: 0o600 });

				const error = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
					tui.stop();
					let error: string | undefined;
					try {
						process.stdout.write("\x1b[2J\x1b[H");
						const result = spawnSync("nvim", [
							"-n", "-i", "NONE", "-c",
							"lua require('pi_diff').open(vim.env.PI_PROMPT_DIFF, { quit = true })",
						], {
							cwd: ctx.cwd,
							stdio: "inherit",
							env: { ...process.env, PI_PROMPT_DIFF: payload },
						});
						if (result.error) error = result.error.message;
						else if (result.status !== 0) error = `Neovim exited: ${result.signal ?? result.status}`;
					} finally {
						tui.start();
						tui.requestRender(true);
					}
					done(error);
					return { render: () => [], invalidate() {} };
				});
				if (error) ctx.ui.notify(error, "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (directory) await rm(directory, { recursive: true, force: true });
			}
		},
	});
}
