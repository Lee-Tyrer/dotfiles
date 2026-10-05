/**
 * /diff [count] reviews prompt edits; /diff branch [base] reviews the Git branch.
 * The Neovim picker switches between loaded prompts and the combined Git diff.
 * Review comments are sent as one follow-up when Neovim exits.
 * Uses tool-result details.diff, including history from before this extension loaded.
 * Prompt reviews exclude Write and Bash changes; Git reviews include tracked changes.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const NESTED_DIFF_ENTRY = "prompt-diff:nested-edit";

interface DiffChange {
	toolCallId: string;
	path: string;
	diff: string;
	format?: "unified";
}

interface PromptDiff {
	prompt: string;
	timestamp: string;
	changes: DiffChange[];
	omittedWrites: number;
	missingEdits: number;
	kind?: "git";
	description?: string;
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

export function collectPromptDiffs(entries: readonly SessionEntry[], count: number): PromptDiff[] {
	const starts = entries.flatMap((entry, index) =>
		entry.type === "message" && entry.message.role === "user" ? [index] : []);
	return starts.slice(-count).flatMap((start, index, selected) => {
		const end = selected[index + 1] ?? entries.length;
		const review = collectLatestPromptDiff(entries.slice(start, end));
		return review ? [review] : [];
	});
}

function gitOutput(cwd: string, args: string[], optional = false): string | undefined {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) {
		if (optional) return undefined;
		throw new Error(result.error?.message ?? (result.stderr.trim() || "Git command failed."));
	}
	return result.stdout;
}

export function collectGitBranchDiff(cwd: string, requestedBase?: string): PromptDiff {
	const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"])!.trim();
	const branch = gitOutput(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)?.trim()
		?? gitOutput(root, ["rev-parse", "--short", "HEAD"])!.trim();
	const defaultRef = gitOutput(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], true)?.trim();
	const candidates = [defaultRef, "origin/main", "origin/master", "main", "master"];
	const base = requestedBase ?? candidates.find((ref) => ref && ref !== branch
		&& gitOutput(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], true) !== undefined);
	if (!base) throw new Error("Could not determine the Git base. Use /diff branch <base-ref>.");
	const baseCommit = gitOutput(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])!.trim();
	const mergeBase = gitOutput(root, ["merge-base", "HEAD", baseCommit])!.trim();
	const paths = gitOutput(root, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", mergeBase, "--"])!
		.split("\0").filter(Boolean);
	return {
		kind: "git",
		prompt: `Git branch: ${branch} vs ${base}`,
		timestamp: new Date().toISOString(),
		description: `Merge base: ${mergeBase.slice(0, 12)}. Includes committed, staged and unstaged tracked changes; untracked files are excluded.`,
		omittedWrites: 0,
		missingEdits: 0,
		changes: paths.map((path, index) => ({
			toolCallId: `git:${index}`,
			path: join(root, path),
			format: "unified",
			diff: gitOutput(root, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=4", mergeBase, "--", path])!.trimEnd(),
		})),
	};
}

interface ReviewComment {
	promptIndex: number;
	changeIndex: number;
	startLine?: number;
	endLine?: number;
	text: string;
}

function formatComments(reviews: PromptDiff[], comments: ReviewComment[]): string | undefined {
	const sections = comments.flatMap((comment) => {
		const review = reviews[comment.promptIndex - 1];
		const change = review?.changes[comment.changeIndex - 1];
		if (!change || typeof comment.text !== "string" || !comment.text.trim()) return [];
		const start = comment.startLine;
		const end = comment.endLine;
		const location = typeof start === "number" && Number.isSafeInteger(start) && start > 0
			? `:${start}${typeof end === "number" && Number.isSafeInteger(end) && end > start ? `-${end}` : ""}`
			: "";
		return [`${change.path}${location}: ${comment.text.trim()}`];
	});
	return sections.length
		? `Please review and address these comments:\n\n${sections.join("\n\n")}`
		: undefined;
}

async function submitComments(pi: ExtensionAPI, text: string): Promise<boolean> {
	let acknowledge!: (received: boolean) => void;
	const received = new Promise<boolean>((resolve) => { acknowledge = resolve; });
	// sendUserMessage is fire-and-forget; confirm delivery from the actual user message.
	const unsubscribe = pi.on("message_end", (event) => {
		if (event.message.role !== "user") return;
		const content = event.message.content;
		const message = typeof content === "string" ? content
			: content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (message === text) acknowledge(true);
	});
	const timeout = setTimeout(() => acknowledge(false), 10_000);
	timeout.unref();
	try {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
		return await received;
	} finally {
		clearTimeout(timeout);
		unsubscribe();
	}
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
		description: "Pick prompt or Git branch diffs: /diff [count] or /diff branch [base]",
		handler: async (args, ctx) => {
			const argument = args.trim();
			const branchArgs = /^branch(?:\s+(\S+))?$/.exec(argument);
			const count = argument && !branchArgs ? Number(argument) : undefined;
			if (argument && !branchArgs && (!/^[1-9]\d*$/.test(argument) || !Number.isSafeInteger(count))) {
				ctx.ui.notify("Usage: /diff [positive prompt count] or /diff branch [base-ref]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/diff requires interactive Pi.", "warning");
				return;
			}
			await ctx.waitForIdle();

			let directory: string | undefined;
			let keepDirectory = false;
			try {
				const entries = ctx.sessionManager.getBranch();
				const reviews = branchArgs ? [] : collectPromptDiffs(entries, count ?? entries.length);
				const initialPrompt = Math.max(1, reviews.length);
				let branchError: string | undefined;
				try {
					reviews.push(collectGitBranchDiff(ctx.cwd, branchArgs?.[1]));
				} catch (error) {
					if (branchArgs) throw error;
					branchError = error instanceof Error ? error.message : String(error);
				}
				if (!reviews.length) {
					ctx.ui.notify("No prompts available to review.", "info");
					return;
				}
				directory = await mkdtemp(join(tmpdir(), "pi-prompt-diff-"));
				keepDirectory = true;
				const payload = join(directory, "review.json");
				const commentsPath = join(directory, "comments.json");
				await writeFile(payload, JSON.stringify({ prompts: reviews, initialPrompt, branchError }), { mode: 0o600 });

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
							env: { ...process.env, PI_PROMPT_DIFF: payload, PI_PROMPT_DIFF_COMMENTS: commentsPath },
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
				if (error) ctx.ui.notify(error, "warning");
				let comments: ReviewComment[];
				try {
					comments = JSON.parse(await readFile(commentsPath, "utf8"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						keepDirectory = false;
						ctx.ui.notify("No saved diff comments found; nothing submitted.", "info");
						return;
					}
					throw error;
				}
				if (!Array.isArray(comments)) throw new Error("Invalid diff review comments.");
				const followUp = formatComments(reviews, comments);
				if (!followUp) {
					if (comments.length) throw new Error("Saved diff comments could not be formatted.");
					keepDirectory = false;
					ctx.ui.notify("No diff comments added; nothing submitted.", "info");
					return;
				}
				const draftPath = join(directory, "followup.txt");
				await writeFile(draftPath, followUp, { mode: 0o600 });
				ctx.ui.notify("Submitting diff comments...", "info");
				if (await submitComments(pi, followUp)) {
					keepDirectory = false;
					ctx.ui.notify("Diff comments submitted.", "info");
				} else {
					ctx.ui.notify(`Diff comment submission not confirmed. Copy the [saved follow-up](file://${draftPath}) into Pi to retry.`, "warning");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Diff comments not submitted: ${message}${directory && keepDirectory ? `\n[Review files preserved](file://${directory}/)` : ""}`, "error");
			} finally {
				if (directory && !keepDirectory) await rm(directory, { recursive: true, force: true });
			}
		},
	});
}
