/**
 * Snapshot-based diff review.
 *
 * Every user prompt snapshots the working tree before it runs and after it settles,
 * so prompt diffs include changes from any tool (edit, write, bash scripts, formatters).
 * Snapshots are commits in a private Git repo under ~/.pi/agent/snapshots that uses the
 * project directory as its work tree; the project's own repo, index and refs are untouched.
 *
 * /diff                latest prompt with changes
 * /diff <n>            last n prompts combined
 * /diff session        every prompt in this session
 * /diff branch [base]  Git branch vs merge base, including uncommitted and untracked changes
 *
 * Review happens in Neovim (diffview.nvim, side by side). Comments are sent back as one follow-up.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SNAPSHOT_ENTRY = "prompt-diff:snapshot";
const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXCLUDES = [
	"node_modules/", ".venv/", "venv/", "__pycache__/", ".mypy_cache/", ".pytest_cache/",
	".ruff_cache/", ".cache/", ".DS_Store",
];

interface SnapshotData {
	phase: "before" | "after";
	run: string;
	commit: string;
	gitDir: string;
	root: string;
	prompt?: string;
	timestamp: string;
}

interface Repo {
	root: string;
	gitDir: string;
	realGitDir?: string;
}

interface Range {
	id: string;
	kind: "snapshot" | "branch";
	label: string;
	title: string;
	from: string;
	to?: string;
	gitDir?: string;
	files?: number;
	insertions?: number;
	deletions?: number;
	prompt?: number;
}

interface ReviewComment {
	path: string;
	side: "before" | "after";
	startLine: number;
	endLine: number;
	text: string;
	excerpt?: string;
	range?: string;
	filetype?: string;
}

// Keep Git from inheriting repo selection from the environment Pi was started in.
function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|COMMON_DIR)$/.test(key)) env[key] = value;
	}
	return env;
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...cleanEnv(),
		GIT_AUTHOR_NAME: "pi", GIT_AUTHOR_EMAIL: "pi@localhost",
		GIT_COMMITTER_NAME: "pi", GIT_COMMITTER_EMAIL: "pi@localhost",
		GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
		...extra,
	};
}

function git(args: string[], options: { cwd: string; env?: Record<string, string>; allowFail?: boolean }): Promise<string | undefined> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd: options.cwd, env: gitEnv(options.env), maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) return resolvePromise(stdout);
			if (options.allowFail) return resolvePromise(undefined);
			reject(new Error(`git ${args[0]}: ${String(stderr).trim() || error.message}`));
		});
	});
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class Snapshots {
	private queue: Promise<unknown> = Promise.resolve();
	private repos = new Map<string, Promise<Repo | undefined>>();
	private readonly baseDir = join(getAgentDir(), "snapshots");

	locate(cwd: string): Promise<Repo | undefined> {
		let repo = this.repos.get(cwd);
		if (!repo) {
			repo = this.findRepo(cwd);
			this.repos.set(cwd, repo);
		}
		return repo;
	}

	private async findRepo(cwd: string): Promise<Repo | undefined> {
		const top = (await git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true }))?.trim();
		const root = resolve(top || cwd);
		// Without a Git repo to bound it, snapshotting $HOME or / would copy far too much.
		if (!top && (root === homedir() || root === sep)) return undefined;
		const realGitDir = top
			? (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, allowFail: true }))?.trim()
			: undefined;
		const gitDir = join(this.baseDir, `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.git`);
		return { root, gitDir, realGitDir };
	}

	// Re-checked on every snapshot: cleanup in another Pi process may have removed an idle repo.
	private async ensureRepo(repo: Repo): Promise<void> {
		if (existsSync(join(repo.gitDir, "HEAD"))) return;
		await mkdir(this.baseDir, { recursive: true });
		await git(["init", "--bare", "--quiet", repo.gitDir], { cwd: this.baseDir });
		await writeFile(join(repo.gitDir, "pi-root"), `${repo.root}\n`);
	}

	private async writeExcludes(repo: Repo): Promise<void> {
		const lines: string[] = [];
		if (!repo.realGitDir) lines.push(...DEFAULT_EXCLUDES);
		// Keep Pi's own runtime data out when reviewing a directory that contains it.
		const agentRel = relative(repo.root, getAgentDir());
		if (!agentRel.startsWith("..") && !agentRel.startsWith(sep)) {
			const prefix = agentRel ? `/${agentRel.split(sep).join("/")}/` : "/";
			lines.push(`${prefix}sessions/`, `${prefix}snapshots/`, `${prefix}npm/`, `${prefix}auth.json`);
		}
		if (repo.realGitDir) {
			const exclude = await readFile(join(repo.realGitDir, "info", "exclude"), "utf8").catch(() => "");
			lines.push(exclude);
		}
		const content = `${lines.join("\n")}\n`;
		const path = join(repo.gitDir, "info", "exclude");
		if ((await readFile(path, "utf8").catch(() => undefined)) === content) return;
		await mkdir(join(repo.gitDir, "info"), { recursive: true });
		await writeFile(path, content);
	}

	/** Commit the current working tree to the session's snapshot ref. */
	snapshot(cwd: string, sessionId: string, message: string): Promise<{ repo: Repo; commit: string } | undefined> {
		const task = this.queue.then(async () => {
			const repo = await this.locate(cwd);
			if (!repo) return undefined;
			await this.ensureRepo(repo);
			await this.writeExcludes(repo);
			const env = { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.root };
			const options = { cwd: repo.root, env };
			for (let attempt = 0; ; attempt++) {
				try {
					await git([
						"-c", "advice.addEmbeddedRepo=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
						"-c", "core.fsmonitor=false", "add", "--all", "--ignore-errors", "--", ".",
					], options);
					break;
				} catch (error) {
					// Another Pi session in this directory may hold the shared snapshot index.
					if (attempt < 20 && /index\.lock/.test(String(error))) {
						await sleep(150);
						continue;
					}
					throw error;
				}
			}
			const tree = (await git(["write-tree"], options))!.trim();
			const ref = `refs/pi/sessions/${sessionId}`;
			const parent = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { ...options, allowFail: true }))?.trim();
			if (parent) {
				const parentTree = (await git(["rev-parse", `${parent}^{tree}`], options))!.trim();
				if (parentTree === tree) return { repo, commit: parent };
			}
			const commit = (await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], options))!.trim();
			await git(["update-ref", ref, commit], options);
			return { repo, commit };
		});
		this.queue = task.catch(() => undefined);
		return task;
	}

	/**
	 * Daily cleanup across every snapshot repo, including projects no longer visited:
	 * drop session refs idle for RETENTION_DAYS, free their objects, and delete repos
	 * that have no sessions left or whose project directory is gone.
	 */
	async cleanup(): Promise<void> {
		const stamp = join(this.baseDir, ".last-cleanup");
		const last = await stat(stamp).then((info) => info.mtimeMs, () => 0);
		if (Date.now() - last < CLEANUP_INTERVAL_MS) return;
		await mkdir(this.baseDir, { recursive: true });
		await writeFile(stamp, "");
		const now = new Date();
		await utimes(stamp, now, now);

		const cutoffMs = Date.now() - RETENTION_DAYS * 86400_000;
		const names = await readdir(this.baseDir).catch(() => [] as string[]);
		for (const name of names.filter((entry) => entry.endsWith(".git"))) {
			const gitDir = join(this.baseDir, name);
			const options = { cwd: this.baseDir, env: { GIT_DIR: gitDir }, allowFail: true };
			const root = (await readFile(join(gitDir, "pi-root"), "utf8").catch(() => "")).trim();
			const refs = (await git(["for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/pi/sessions/"], options) ?? "")
				.split("\n").filter(Boolean).map((line) => line.split(" "));
			const stale = refs.filter(([, time]) => Number(time) * 1000 < cutoffMs).map(([ref]) => ref!);
			// The index is touched by every snapshot, so a recent mtime means a session may be using this repo.
			const lastUsed = await stat(join(gitDir, "index")).then((info) => info.mtimeMs, () => 0);
			const idle = lastUsed < cutoffMs;
			if (idle && (!root || !existsSync(root) || stale.length === refs.length)) {
				await rm(gitDir, { recursive: true, force: true });
				continue;
			}
			if (!stale.length) continue;
			for (const ref of stale) await git(["update-ref", "-d", ref], options);
			// A one-hour grace keeps objects another process is writing right now.
			await git(["gc", "--quiet", "--prune=1.hour.ago"], options);
		}
	}
}

interface PromptRecord {
	run: string;
	prompt: string;
	timestamp: string;
	gitDir: string;
	root: string;
	from: string;
	to?: string;
}

function collectPrompts(entries: readonly SessionEntry[], root: string): PromptRecord[] {
	const prompts: PromptRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SNAPSHOT_ENTRY) continue;
		const data = entry.data as Partial<SnapshotData> | undefined;
		if (!data || typeof data.commit !== "string" || data.root !== root || typeof data.gitDir !== "string") continue;
		if (data.phase === "before") {
			prompts.push({
				run: String(data.run), prompt: data.prompt ?? "", timestamp: data.timestamp ?? "",
				gitDir: data.gitDir, root: data.root, from: data.commit,
			});
		} else if (data.phase === "after") {
			const record = prompts.findLast((prompt) => prompt.run === data.run);
			if (record) record.to = data.commit;
		}
	}
	return prompts;
}

// Drop prompts whose snapshots were removed by cleanup (e.g. a session resumed after a week).
function existingPrompts(repo: Repo, prompts: PromptRecord[]): PromptRecord[] {
	if (!prompts.length || !existsSync(join(repo.gitDir, "HEAD"))) return [];
	const commits = prompts.flatMap((prompt) => prompt.to ? [prompt.from, prompt.to] : [prompt.from]);
	const result = spawnSync("git", ["cat-file", "--batch-check=%(objectname)"], {
		cwd: repo.root, env: gitEnv({ GIT_DIR: repo.gitDir }), input: `${commits.join("\n")}\n`, encoding: "utf8",
	});
	const missing = new Set((result.stdout ?? "").split("\n").filter((line) => line.endsWith(" missing")).map((line) => line.split(" ")[0]));
	return prompts.filter((prompt) => !missing.has(prompt.from) && !(prompt.to && missing.has(prompt.to)));
}

function singleLine(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

async function shortstat(repo: Repo, from: string, to: string): Promise<Pick<Range, "files" | "insertions" | "deletions">> {
	const out = await git(["diff", "--shortstat", "--no-renames", from, to], { cwd: repo.root, env: { GIT_DIR: repo.gitDir }, allowFail: true }) ?? "";
	const number = (pattern: RegExp) => Number(pattern.exec(out)?.[1] ?? 0);
	return { files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?/), deletions: number(/(\d+) deletions?/) };
}

async function branchRange(cwd: string, requestedBase?: string): Promise<Range> {
	const run = (args: string[]) => git(args, { cwd, allowFail: true }).then((out) => out?.trim() || undefined);
	const root = await run(["rev-parse", "--show-toplevel"]);
	if (!root) throw new Error("Not in a Git repository.");
	const branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? await run(["rev-parse", "--short", "HEAD"]);
	let base = requestedBase;
	if (!base) {
		const defaultRef = (await run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]))?.replace(/^refs\/remotes\//, "");
		for (const ref of [defaultRef, "origin/main", "origin/master", "main", "master"]) {
			if (ref && ref !== branch && await run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])) {
				base = ref;
				break;
			}
		}
	}
	if (!base) throw new Error("Could not determine the Git base. Use /diff branch <base-ref>.");
	const mergeBase = await run(["merge-base", "HEAD", base]);
	if (!mergeBase) throw new Error(`No merge base between HEAD and ${base}.`);
	return {
		id: "branch", kind: "branch", from: mergeBase,
		label: `Branch  ${branch} vs ${base}`,
		title: `${branch} vs ${base} (working tree)`,
	};
}

function formatComments(comments: ReviewComment[]): string | undefined {
	const sections = comments.flatMap((comment) => {
		if (typeof comment.text !== "string" || !comment.text.trim() || typeof comment.path !== "string") return [];
		const lines = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
		const side = comment.side === "before" ? ` (original code${comment.range ? `, before ${comment.range}` : ""})` : "";
		const excerpt = comment.excerpt?.trimEnd()
			? `\n\`\`\`${comment.filetype ?? ""}\n${comment.excerpt.trimEnd()}\n\`\`\``
			: "";
		return [`${comment.path}:${lines}${side}${excerpt}\n${comment.text.trim()}`];
	});
	return sections.length ? `Please review and address these comments:\n\n${sections.join("\n\n")}` : undefined;
}

async function submitComments(pi: ExtensionAPI, text: string): Promise<boolean> {
	let acknowledge!: (received: boolean) => void;
	const received = new Promise<boolean>((done) => { acknowledge = done; });
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
	const snapshots = new Snapshots();
	let currentRun: string | undefined;

	const record = async (phase: SnapshotData["phase"], cwd: string, sessionId: string, prompt?: string) => {
		const result = await snapshots.snapshot(cwd, sessionId, `${phase}: ${singleLine(prompt ?? currentRun ?? "", 72)}`);
		if (!result) return;
		pi.appendEntry(SNAPSHOT_ENTRY, {
			phase, run: currentRun!, commit: result.commit, gitDir: result.repo.gitDir, root: result.repo.root,
			prompt: prompt?.slice(0, 500), timestamp: new Date().toISOString(),
		} satisfies SnapshotData);
	};

	pi.on("session_start", (_event, ctx) => {
		currentRun = undefined;
		const cwd = ctx.cwd;
		const sessionId = ctx.sessionManager.getSessionId();
		// Warm the shared snapshot index so the first prompt does not pay for a full scan.
		void snapshots.snapshot(cwd, sessionId, "session start").catch(() => undefined);
		void snapshots.cleanup().catch(() => undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		currentRun = randomUUID();
		try {
			await record("before", ctx.cwd, ctx.sessionManager.getSessionId(), event.prompt);
		} catch (error) {
			ctx.ui.notify(`Diff snapshot failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		if (!currentRun) return;
		try {
			await record("after", ctx.cwd, ctx.sessionManager.getSessionId());
		} catch (error) {
			ctx.ui.notify(`Diff snapshot failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.registerCommand("diff", {
		description: "Side-by-side review: /diff [n] | /diff session | /diff branch [base]",
		handler: async (args, ctx) => {
			const argument = args.trim();
			const branchArgs = /^branch(?:\s+(\S+))?$/.exec(argument);
			const count = /^[1-9]\d*$/.test(argument) ? Number(argument) : undefined;
			if (argument && !branchArgs && !count && argument !== "session") {
				ctx.ui.notify("Usage: /diff [n] | /diff session | /diff branch [base-ref]", "warning");
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
				const repo = await snapshots.locate(ctx.cwd);
				const ranges: Range[] = [];
				const sinceRanges: Range[] = [];
				let initial: string | undefined;
				if (repo) {
					const prompts = existingPrompts(repo, collectPrompts(ctx.sessionManager.getBranch(), repo.root));
					let now: string | undefined;
					for (const [index, prompt] of prompts.entries()) {
						if (!prompt.to) {
							prompt.to = prompts[index + 1]?.from
								?? (now ??= (await snapshots.snapshot(ctx.cwd, ctx.sessionManager.getSessionId(), "review"))?.commit);
						}
					}
					const usable = prompts.filter((prompt) => prompt.to);
					const stats = await Promise.all(usable.map((prompt) => shortstat(repo, prompt.from, prompt.to!)));
					usable.forEach((prompt, index) => {
						const number = index + 1;
						ranges.push({
							id: `p${number}`, kind: "snapshot", gitDir: repo.gitDir, from: prompt.from, to: prompt.to, prompt: number,
							label: `Prompt ${number}  ${singleLine(prompt.prompt)}`,
							title: `Prompt ${number}: ${singleLine(prompt.prompt, 120)}`,
							...stats[index],
						});
					});
					const last = usable.at(-1);
					usable.forEach((prompt, index) => {
						if (index === usable.length - 1) return;
						sinceRanges.push({
							id: `since${index + 1}`, kind: "snapshot", gitDir: repo.gitDir, from: prompt.from, to: last!.to,
							label: `Since prompt ${index + 1}  ${singleLine(prompt.prompt)}`,
							title: `Prompts ${index + 1}–${usable.length}`,
						});
					});
					if (usable.length > 1) {
						ranges.push({
							id: "session", kind: "snapshot", gitDir: repo.gitDir, from: usable[0]!.from, to: last!.to,
							label: `Session  all ${usable.length} prompts`, title: `Session: prompts 1–${usable.length}`,
							...await shortstat(repo, usable[0]!.from, last!.to!),
						});
					}
					if (argument === "session") initial = usable.length > 1 ? "session" : usable.length ? "p1" : undefined;
					else if (count) initial = count >= usable.length ? (usable.length > 1 ? "session" : usable.length ? "p1" : undefined)
						: count === 1 ? `p${usable.length}` : `since${usable.length - count + 1}`;
					else if (!branchArgs) {
						const withChanges = ranges.filter((range) => range.prompt && range.files);
						initial = (withChanges.at(-1) ?? ranges.filter((range) => range.prompt).at(-1))?.id;
					}
				}

				let branchError: string | undefined;
				try {
					ranges.push(await branchRange(ctx.cwd, branchArgs?.[1]));
					if (branchArgs || !initial) initial = "branch";
				} catch (error) {
					if (branchArgs) throw error;
					branchError = error instanceof Error ? error.message : String(error);
				}
				if (!ranges.length || !initial) {
					ctx.ui.notify(`No prompt snapshots in this session yet${branchError ? `, and no branch diff: ${branchError}` : "."}`, "info");
					return;
				}

				directory = await mkdtemp(join(tmpdir(), "pi-diff-"));
				keepDirectory = true;
				const payloadPath = join(directory, "review.json");
				const commentsPath = join(directory, "comments.json");
				await writeFile(payloadPath, JSON.stringify({ ranges, sinceRanges, initial, branchError }), { mode: 0o600 });
				const root = repo?.root ?? ctx.cwd;

				const error = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
					tui.stop();
					let error: string | undefined;
					try {
						process.stdout.write("\x1b[2J\x1b[H");
						const result = spawnSync("nvim", ["-n", "-i", "NONE", "-c", "lua require('pi_diff').open(vim.env.PI_DIFF_PAYLOAD)"], {
							cwd: root,
							stdio: "inherit",
							env: { ...cleanEnv(), PI_DIFF_PAYLOAD: payloadPath, PI_DIFF_COMMENTS: commentsPath },
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
						return;
					}
					throw error;
				}
				if (!Array.isArray(comments)) throw new Error("Invalid diff review comments.");
				const followUp = formatComments(comments);
				if (!followUp) {
					keepDirectory = false;
					return;
				}
				const draftPath = join(directory, "followup.txt");
				await writeFile(draftPath, followUp, { mode: 0o600 });
				if (await submitComments(pi, followUp)) {
					keepDirectory = false;
					ctx.ui.notify(`Sent ${comments.length} review comment${comments.length === 1 ? "" : "s"}.`, "info");
				} else {
					ctx.ui.notify(`Diff comment submission not confirmed. Copy the [saved follow-up](file://${draftPath}) into Pi to retry.`, "warning");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/diff failed: ${message}${directory && keepDirectory ? `\n[Review files preserved](file://${directory}/)` : ""}`, "error");
			} finally {
				if (directory && !keepDirectory) await rm(directory, { recursive: true, force: true });
			}
		},
	});
}
