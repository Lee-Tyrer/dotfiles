import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const CODEX_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

type ImageOperation = "generate" | "edit";

const imagegenParameters = Type.Object({
	prompt: Type.String({ description: "The complete image-generation or edit prompt." }),
	operation: Type.Optional(Type.Union([Type.Literal("generate"), Type.Literal("edit")])),
	model: Type.Optional(Type.String({ description: "GPT Image model. Defaults to gpt-image-2." })),
	imagePaths: Type.Optional(
		Type.Array(Type.String({ description: "Workspace-relative edit/reference image path." }), {
			description: "Required for operation=edit; up to 5 images, matching Codex image generation.",
			maxItems: 5,
		}),
	),
	outputPath: Type.Optional(
		Type.String({ description: "Workspace-relative output path. A numeric suffix is added for additional images." }),
	),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of variants. Defaults to 1." })),
	size: Type.Optional(Type.String({ description: "Image size, for example 1024x1024, 1536x1024, or auto." })),
	quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")])),
	background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")])),
});

type ImagegenParameters = Static<typeof imagegenParameters>;

interface ImageApiResponse {
	data?: Array<{ b64_json?: string }>;
}

interface CodexAuthResult {
	auth: {
		apiKey?: string;
		headers?: Record<string, string | null | undefined>;
	};
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

function resolveWorkspacePath(cwd: string, path: string): string {
	const workspace = resolve(cwd);
	const resolved = resolve(workspace, path);
	const outside = relative(workspace, resolved);
	if (outside === ".." || outside.startsWith(`..${"/"}`) || isAbsolute(outside)) {
		throw new Error(`Path must be inside the workspace: ${path}`);
	}
	return resolved;
}

function outputPathFor(path: string, index: number): string {
	if (index === 0) return path;
	const extension = extname(path);
	const stem = extension.length > 0 ? path.slice(0, -extension.length) : path;
	return `${stem}-${index + 1}${extension}`;
}

function decodeAccountId(accessToken: string): string {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) throw new Error("Invalid OAuth token");
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		const accountId = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
		if (typeof accountId !== "string" || accountId.length === 0) throw new Error("Missing ChatGPT account id");
		return accountId;
	} catch {
		throw new Error("Could not read the ChatGPT account id from the Codex OAuth session.");
	}
}

async function getCodexAuth(ctx: ExtensionContext): Promise<{ token: string; accountId: string; baseUrl: string; headers: Headers }> {
	const resolved = (await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER)) as CodexAuthResult | undefined;
	const token = resolved?.auth.apiKey;
	if (!token) {
		throw new Error("ChatGPT/Codex login is required for image generation. Run /login and choose OpenAI (ChatGPT Plus/Pro). No OPENAI_API_KEY is used by this tool.");
	}

	const accountId = decodeAccountId(token);
	const provider = ctx.modelRegistry.getProvider(CODEX_PROVIDER);
	const baseUrl = (provider?.baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	const headers = new Headers();
	for (const [key, value] of Object.entries(resolved?.auth.headers ?? {})) {
		if (value !== null && value !== undefined) headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", "pi");
	headers.set("Content-Type", "application/json");
	headers.set("Accept", "application/json");
	return { token, accountId, baseUrl, headers };
}

function resolveCodexImageBaseUrl(baseUrl: string): string {
	// Pi's openai-codex provider stores the shared `/backend-api` base URL, while
	// Codex image and Responses routes live below `/backend-api/codex`.
	const normalized = baseUrl.trim().replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
	if (normalized.endsWith("/codex")) return normalized;
	return `${normalized}/codex`;
}

function isTransientStatus(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
	}
	return Math.min(30_000, 1000 * 2 ** attempt);
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolveSleep, rejectSleep) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const finish = () => {
			cleanup();
			resolveSleep();
		};
		const abort = () => {
			cleanup();
			rejectSleep(new Error("Request was aborted"));
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
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

async function loadReferenceImages(cwd: string, paths: string[]): Promise<Array<{ image_url: string }>> {
	return Promise.all(
		paths.map(async (imagePath) => {
			const absolutePath = resolveWorkspacePath(cwd, imagePath);
			const metadata = await stat(absolutePath);
			if (metadata.size > MAX_REFERENCE_BYTES) {
				throw new Error(`Reference image exceeds the 50MB limit: ${imagePath}`);
			}
			const bytes = await readFile(absolutePath);
			const dataUrl = `data:${mimeTypeFor(imagePath)};base64,${bytes.toString("base64")}`;
			return { image_url: dataUrl };
		}),
	);
}

async function requestImages(
	params: ImagegenParameters,
	cwd: string,
	ctx: ExtensionContext,
	toolCallId: string,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const operation: ImageOperation = params.operation ?? (params.imagePaths?.length ? "edit" : "generate");
	if (operation === "edit" && !params.imagePaths?.length) {
		throw new Error("imagePaths is required for operation=edit.");
	}
	if (operation === "generate" && params.imagePaths?.length) {
		throw new Error("Reference images use operation=edit, matching Codex image generation.");
	}

	const model = params.model ?? DEFAULT_MODEL;
	if (!model.startsWith("gpt-image-")) {
		throw new Error("model must be a GPT Image model, such as gpt-image-2 or gpt-image-1.5.");
	}

	const auth = await getCodexAuth(ctx);
	const requestedBackground = params.background ?? "auto";
	const prompt =
		requestedBackground === "transparent" && !/transparent/i.test(params.prompt)
			? `${params.prompt}\nOutput requirement: genuinely transparent background, clean edges, no halo.`
			: params.prompt;
	// Match Codex's native gpt-image-2 request: native transparency is requested in
	// the prompt while the API background control remains `auto`.
	const background = requestedBackground === "transparent" && model === DEFAULT_MODEL ? "auto" : requestedBackground;
	const body: Record<string, unknown> = {
		prompt,
		model,
		background,
		quality: params.quality ?? "auto",
		size: params.size ?? "auto",
	};
	if ((params.count ?? 1) > 1) body.n = params.count;
	if (operation === "edit") body.images = await loadReferenceImages(cwd, params.imagePaths ?? []);

	if (toolCallId) {
		auth.headers.set("x-codex-image-turn-id", toolCallId);
	}

	const endpoint = `${resolveCodexImageBaseUrl(auth.baseUrl)}/images/${operation === "generate" ? "generations" : "edits"}`;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: auth.headers,
			body: JSON.stringify(body),
			signal,
		});
		if (response.ok) {
			const payload = (await response.json()) as ImageApiResponse;
			const images = (payload.data ?? []).flatMap((item) => (item.b64_json ? [item.b64_json] : []));
			if (images.length === 0) throw new Error("ChatGPT image backend returned no base64 image data.");
			return images;
		}

		const responseBody = await response.text();
		if (attempt < MAX_ATTEMPTS - 1 && isTransientStatus(response.status)) {
			await sleep(retryDelayMs(response, attempt), signal);
			continue;
		}
		throw new Error(`ChatGPT image generation failed (${response.status}): ${errorMessage(response.status, responseBody)}`);
	}

	throw new Error("ChatGPT image generation failed after retries.");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "imagegen",
		label: "Generate image",
		description:
			"Generate or edit raster images through the ChatGPT/Codex subscription-backed image backend. Uses the local openai-codex OAuth session, not OPENAI_API_KEY; accepts workspace image paths for edits and returns generated images.",
		promptSnippet: "Generate or edit images with the ChatGPT/Codex image backend",
		parameters: imagegenParameters,
		renderResult(result, { isPartial }, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			if (isPartial) {
				text.setText(theme.fg("warning", "Generating image..."));
				return text;
			}

			const details = result.details as { savedPaths?: unknown } | undefined;
			const savedPaths = Array.isArray(details?.savedPaths)
				? details.savedPaths.filter((path): path is string => typeof path === "string")
				: [];
			if (savedPaths.length > 0) {
				const links = savedPaths.map((path) => {
					const display = theme.fg("accent", path);
					return getCapabilities().hyperlinks ? hyperlink(display, pathToFileURL(path).href) : display;
				});
				text.setText(`${theme.fg("toolOutput", "Saved:")}\n${links.join("\n")}`);
				return text;
			}

			const message = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			text.setText(theme.fg(context.isError ? "error" : "toolOutput", message));
			return text;
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const images = await requestImages(params, ctx.cwd, ctx, toolCallId, signal);
				const content = images.map((data) => ({
					type: "image" as const,
					data,
					mimeType: "image/png",
				}));
				const savedPaths: string[] = [];
				if (params.outputPath) {
					const outputPath = resolveWorkspacePath(ctx.cwd, params.outputPath);
					for (const [index, image] of images.entries()) {
						const path = outputPathFor(outputPath, index);
						await mkdir(dirname(path), { recursive: true });
						await writeFile(path, Buffer.from(image, "base64"), { flag: "wx" });
						savedPaths.push(path);
					}
				}
				content.unshift({
					type: "text",
					text: savedPaths.length
						? `Generated with ChatGPT/Codex subscription and saved:\n${savedPaths.join("\n")}`
						: `Generated ${images.length} image(s) with ChatGPT/Codex subscription.`,
				});
				return { content, details: { savedPaths, provider: CODEX_PROVIDER } };
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});
}
