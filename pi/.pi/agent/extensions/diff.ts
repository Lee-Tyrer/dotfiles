/**
 * Side-by-side review of uncommitted changes in Neovim (diffview.nvim).
 *
 * /diff                working tree vs HEAD
 * /diff branch [base]  working tree vs the branch's merge base
 *
 * Comments written during review are sent back as one follow-up prompt.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface Range {
	id: "head" | "branch";
	label: string;
	title: string;
	from: string;
	files?: number;
	insertions?: number;
	deletions?: number;
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

function formatComments(comments: ReviewComment[]): string | undefined {
	const sections = comments.map((comment) => {
		const lines = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : `${comment.startLine}`;
		const side = comment.side === "before" ? ` (original code${comment.range ? `, before ${comment.range}` : ""})` : "";
		const excerpt = comment.excerpt?.trimEnd()
			? `\n\`\`\`${comment.filetype ?? ""}\n${comment.excerpt.trimEnd()}\n\`\`\``
			: "";
		return `${comment.path}:${lines}${side}${excerpt}\n${comment.text.trim()}`;
	});
	return sections.length ? `Please review and address these comments:\n\n${sections.join("\n\n")}` : undefined;
}

export default function diffExtension(pi: ExtensionAPI): void {
	const git = async (cwd: string, args: string[]): Promise<string | undefined> => {
		const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 10_000 });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};

	const shortstat = async (cwd: string, from: string): Promise<Pick<Range, "files" | "insertions" | "deletions">> => {
		const out = await git(cwd, ["diff", "--shortstat", from]) ?? "";
		const number = (pattern: RegExp) => Number(pattern.exec(out)?.[1] ?? 0);
		return { files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?/), deletions: number(/(\d+) deletions?/) };
	};

	const branchRange = async (cwd: string, requestedBase?: string): Promise<Range | string> => {
		const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? await git(cwd, ["rev-parse", "--short", "HEAD"]);
		let base = requestedBase;
		if (!base) {
			const defaultRef = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]))?.replace(/^refs\/remotes\//, "");
			for (const ref of [defaultRef, "origin/main", "origin/master", "main", "master"]) {
				if (ref && ref !== branch && await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) {
					base = ref;
					break;
				}
			}
		}
		if (!base) return "Could not determine the Git base. Use /diff branch <base-ref>.";
		const mergeBase = await git(cwd, ["merge-base", "HEAD", base]);
		if (!mergeBase) return `No merge base between HEAD and ${base}.`;
		return {
			id: "branch", from: mergeBase,
			label: `Branch  ${branch} vs ${base}`,
			title: `${branch} vs ${base} (working tree)`,
			...await shortstat(cwd, mergeBase),
		};
	};

	const review = async (ctx: ExtensionCommandContext, root: string, payload: object): Promise<void> => {
		const directory = await mkdtemp(join(tmpdir(), "pi-diff-"));
		try {
			const payloadPath = join(directory, "review.json");
			const commentsPath = join(directory, "comments.json");
			await writeFile(payloadPath, JSON.stringify(payload));

			const error = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");
				const result = spawnSync("nvim", ["-n", "-i", "NONE", "-c", "lua require('pi_diff').open(vim.env.PI_DIFF_PAYLOAD)"], {
					cwd: root,
					stdio: "inherit",
					env: { ...process.env, PI_DIFF_PAYLOAD: payloadPath, PI_DIFF_COMMENTS: commentsPath },
				});
				tui.start();
				tui.requestRender(true);
				done(result.error?.message ?? (result.status !== 0 ? `Neovim exited: ${result.signal ?? result.status}` : undefined));
				return { render: () => [], invalidate() {} };
			});
			if (error) ctx.ui.notify(error, "warning");

			const comments = await readFile(commentsPath, "utf8").then((text) => JSON.parse(text) as ReviewComment[], () => []);
			const followUp = formatComments(comments);
			if (!followUp) return;
			await pi.sendUserMessage(followUp, { deliverAs: "followUp" });
			ctx.ui.notify(`Sent ${comments.length} review comment${comments.length === 1 ? "" : "s"}.`, "info");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};

	pi.registerCommand("diff", {
		description: "Side-by-side review of uncommitted changes: /diff | /diff branch [base]",
		handler: async (args, ctx) => {
			const branchArgs = /^branch(?:\s+(\S+))?$/.exec(args.trim());
			if (args.trim() && !branchArgs) {
				ctx.ui.notify("Usage: /diff | /diff branch [base-ref]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/diff requires interactive Pi.", "warning");
				return;
			}
			await ctx.waitForIdle();

			const root = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
			if (!root) {
				ctx.ui.notify("/diff needs a Git repository.", "warning");
				return;
			}
			const head: Range = { id: "head", from: "HEAD", label: "Uncommitted  working tree vs HEAD", title: "Uncommitted changes", ...await shortstat(root, "HEAD") };
			const branch = await branchRange(root, branchArgs?.[1]);
			if (branchArgs && typeof branch === "string") {
				ctx.ui.notify(branch, "warning");
				return;
			}
			const ranges = typeof branch === "string" ? [head] : [head, branch];
			try {
				await review(ctx, root, {
					ranges,
					initial: branchArgs ? "branch" : "head",
					branchError: typeof branch === "string" ? branch : undefined,
				});
			} catch (error) {
				ctx.ui.notify(`/diff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
