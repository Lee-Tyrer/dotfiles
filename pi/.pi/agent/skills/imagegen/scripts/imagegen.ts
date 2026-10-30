#!/usr/bin/env node
/**
 * Batch-capable ChatGPT/Codex image generation using pi's openai-codex login.
 *
 * Single: node imagegen.ts --prompt "..." --out out.png [--edit a.png ...] [--size] [--quality] [--background] [--count] [--model]
 * Batch:  node imagegen.ts --batch jobs.jsonl [--concurrency 4]
 *         Each line: {"prompt": "...", "out": "...", "edit": [...], "size": ..., "quality": ..., "background": ..., "count": ..., "model": ...}
 */
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const AUTH_PATH = join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
const ENDPOINT_BASE = "https://chatgpt.com/backend-api/codex/images";
const DEFAULT_MODEL = "gpt-image-2";
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

// The Codex backend ignores the `size` field and picks dimensions from the prompt, so each size
// is sent as an aspect hint. Output is close to, not exactly, the named dimensions.
const SIZES: Record<string, string> = {
	auto: "",
	"1024x1024": "Square 1:1 image.",
	"1536x1024": "Wide 3:2 landscape-orientation image.",
	"1024x1536": "Tall 2:3 portrait-orientation image.",
};

const HELP = `Usage:
  node imagegen.ts --prompt <text> --out <file.png> [options]
  node imagegen.ts --batch <jobs.jsonl> [--concurrency N]

Options:
  --prompt <text>        Image prompt
  --out <file.png>       Output path; never overwritten, existing files are skipped
  --edit <image>         Reference/edit image (PNG/JPEG/WebP), repeat up to 5 times
  --size <size>          ${Object.keys(SIZES).join(" | ")} (default auto)
                         Sent as an aspect hint; output dimensions are approximate
  --quality <q>          low | medium | high | auto (default auto)
  --background <b>       transparent | opaque | auto (default auto)
  --count <n>            Variants per prompt, 1-10 (extra files get -2, -3 suffixes)
  --model <model>        Default ${DEFAULT_MODEL}
  --batch <jobs.jsonl>   One JSON job per line: {"prompt", "out", "edit", "size", "quality", "background", "count", "model"}
  --concurrency <n>      Parallel requests in batch mode (default 4)
  -h, --help             Show this help`;

interface Job {
	prompt: string;
	out: string;
	edit?: string[];
	size?: string;
	quality?: string;
	background?: string;
	count?: number;
	model?: string;
}

interface Auth {
	token: string;
	accountId: string;
}

async function loadAuth(): Promise<Auth> {
	let entry: { access?: string; accountId?: string; expires?: number } | undefined;
	try {
		entry = JSON.parse(await readFile(AUTH_PATH, "utf8"))["openai-codex"];
	} catch {
		throw new Error(`Could not read ${AUTH_PATH}. Open pi and run /login with OpenAI (ChatGPT Plus/Pro).`);
	}
	if (!entry?.access || !entry.accountId) {
		throw new Error("No openai-codex login in pi auth.json. Open pi and run /login with OpenAI (ChatGPT Plus/Pro).");
	}
	if (entry.expires && entry.expires < Date.now() + 60_000) {
		throw new Error("The Codex access token has expired. Open pi once so it refreshes the login, then rerun.");
	}
	return { token: entry.access, accountId: entry.accountId };
}

function mimeTypeFor(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			throw new Error(`Unsupported image type: ${path}. Use PNG, JPEG, or WebP.`);
	}
}

function outputPathFor(path: string, index: number): string {
	if (index === 0) return path;
	const extension = extname(path);
	const stem = extension.length > 0 ? path.slice(0, -extension.length) : path;
	return `${stem}-${index + 1}${extension}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function retryDelayMs(response: Response, attempt: number): number {
	const seconds = Number(response.headers.get("retry-after"));
	if (response.headers.has("retry-after") && Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
	return Math.min(30_000, 1000 * 2 ** attempt);
}

function errorMessage(status: number, body: string): string {
	try {
		const payload = JSON.parse(body) as { error?: { message?: string } };
		if (payload.error?.message) return payload.error.message;
	} catch {
		// Fall through to the raw response.
	}
	return body.trim() || `ChatGPT image backend returned ${status}`;
}

async function requestImages(job: Job, auth: Auth): Promise<string[]> {
	const model = job.model ?? DEFAULT_MODEL;
	const background = job.background ?? "auto";
	const sizeHint = SIZES[job.size ?? "auto"];
	const sizedPrompt = sizeHint ? `${sizeHint} ${job.prompt}` : job.prompt;
	const prompt =
		background === "transparent" && !/transparent/i.test(sizedPrompt)
			? `${sizedPrompt}\nOutput requirement: genuinely transparent background, clean edges, no halo.`
			: sizedPrompt;
	// Match Codex's native gpt-image-2 request: transparency goes in the prompt, the API control stays `auto`.
	const body: Record<string, unknown> = {
		prompt,
		model,
		background: background === "transparent" && model === DEFAULT_MODEL ? "auto" : background,
		quality: job.quality ?? "auto",
		size: "auto",
	};
	if ((job.count ?? 1) > 1) body.n = job.count;
	const edit = job.edit ?? [];
	if (edit.length > 0) {
		body.images = await Promise.all(
			edit.map(async (path) => {
				if ((await stat(path)).size > MAX_REFERENCE_BYTES) throw new Error(`Reference image exceeds 50MB: ${path}`);
				return { image_url: `data:${mimeTypeFor(path)};base64,${(await readFile(path)).toString("base64")}` };
			}),
		);
	}

	const headers = {
		Authorization: `Bearer ${auth.token}`,
		"chatgpt-account-id": auth.accountId,
		originator: "pi",
		"User-Agent": "pi",
		"Content-Type": "application/json",
		Accept: "application/json",
		"x-codex-image-turn-id": randomUUID(),
	};
	const endpoint = `${ENDPOINT_BASE}/${edit.length > 0 ? "edits" : "generations"}`;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
		if (response.ok) {
			const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
			const images = (payload.data ?? []).flatMap((item) => (item.b64_json ? [item.b64_json] : []));
			if (images.length === 0) throw new Error("ChatGPT image backend returned no base64 image data.");
			return images;
		}
		const responseBody = await response.text();
		if (attempt < MAX_ATTEMPTS - 1 && [429, 500, 502, 503, 504].includes(response.status)) {
			await new Promise((r) => setTimeout(r, retryDelayMs(response, attempt)));
			continue;
		}
		throw new Error(`(${response.status}) ${errorMessage(response.status, responseBody)}`);
	}
	throw new Error("Failed after retries.");
}

type Result = { job: Job; status: "ok" | "skipped" | "failed"; paths: string[]; ms: number; error?: string };

async function runJob(job: Job, auth: Auth): Promise<Result> {
	const start = performance.now();
	const out = resolve(job.out);
	if (await exists(out)) return { job, status: "skipped", paths: [out], ms: 0 };
	try {
		const images = await requestImages(job, auth);
		const paths: string[] = [];
		for (const [index, image] of images.entries()) {
			const path = outputPathFor(out, index);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, Buffer.from(image, "base64"), { flag: "wx" });
			paths.push(path);
		}
		return { job, status: "ok", paths, ms: performance.now() - start };
	} catch (error) {
		return { job, status: "failed", paths: [], ms: performance.now() - start, error: error instanceof Error ? error.message : String(error) };
	}
}

function checkSize(size: string | undefined, where = ""): void {
	if (size !== undefined && !(size in SIZES)) {
		throw new Error(`${where}unsupported size "${size}". Use one of: ${Object.keys(SIZES).join(", ")}`);
	}
}

function parseJobs(text: string, source: string): Job[] {
	return text
		.split("\n")
		.map((line, i) => ({ line: line.trim(), n: i + 1 }))
		.filter(({ line }) => line.length > 0)
		.map(({ line, n }) => {
			const job = JSON.parse(line) as Job;
			if (!job.prompt || !job.out) throw new Error(`${source}:${n}: each job needs "prompt" and "out"`);
			checkSize(job.size, `${source}:${n}: `);
			return job;
		});
}

async function main() {
	const { values } = parseArgs({
		options: {
			prompt: { type: "string" },
			out: { type: "string" },
			edit: { type: "string", multiple: true },
			size: { type: "string" },
			quality: { type: "string" },
			background: { type: "string" },
			count: { type: "string" },
			model: { type: "string" },
			batch: { type: "string" },
			concurrency: { type: "string", default: "4" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(HELP);
		return;
	}

	let jobs: Job[];
	if (values.batch) {
		jobs = parseJobs(await readFile(values.batch, "utf8"), values.batch);
	} else if (values.prompt && values.out) {
		checkSize(values.size);
		jobs = [
			{
				prompt: values.prompt,
				out: values.out,
				edit: values.edit,
				size: values.size,
				quality: values.quality,
				background: values.background,
				count: values.count ? Number(values.count) : undefined,
				model: values.model,
			},
		];
	} else {
		console.error(HELP);
		process.exit(2);
	}

	const auth = await loadAuth();
	const concurrency = Math.max(1, Number(values.concurrency) || 4);
	const results: Result[] = [];
	const start = performance.now();
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const result = await runJob(jobs[next++], auth);
			results.push(result);
			const tag = `[${results.length}/${jobs.length}]`;
			if (result.status === "failed") console.log(`${tag} FAIL ${result.job.out} (${(result.ms / 1000).toFixed(1)}s): ${result.error}`);
			else console.log(`${tag} ${result.status === "ok" ? "ok  " : "skip"} ${result.paths.join(", ")}${result.status === "ok" ? ` (${(result.ms / 1000).toFixed(1)}s)` : ""}`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

	const wall = (performance.now() - start) / 1000;
	const ok = results.filter((r) => r.status === "ok");
	const failed = results.filter((r) => r.status === "failed");
	const skipped = results.length - ok.length - failed.length;
	const avg = ok.length ? ok.reduce((sum, r) => sum + r.ms, 0) / ok.length / 1000 : 0;
	console.log(
		`\nDone: ${ok.length} ok, ${skipped} skipped, ${failed.length} failed | wall ${wall.toFixed(1)}s | avg per image ${avg.toFixed(1)}s | concurrency ${concurrency}`,
	);
	if (failed.length > 0 && values.batch) {
		const failedPath = values.batch.replace(/\.jsonl$/, "") + ".failed.jsonl";
		await writeFile(failedPath, "");
		for (const r of failed) await appendFile(failedPath, JSON.stringify(r.job) + "\n");
		console.log(`Failed jobs written to ${failedPath}`);
	}
	process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
