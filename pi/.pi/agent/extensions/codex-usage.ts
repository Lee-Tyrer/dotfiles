/**
 * Registers /status for Codex or Claude subscription usage.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type UsageRow = {
	label: string;
	usedPercent: number;
	/** Unix seconds. */
	resetsAt?: number;
};

type CodexWindow = {
	used_percent: number;
	limit_window_seconds: number;
	reset_at: number;
};

type CodexLimit = {
	primary_window?: CodexWindow | null;
	secondary_window?: CodexWindow | null;
};

type CodexUsageResponse = {
	rate_limit?: CodexLimit | null;
	additional_rate_limits?: Array<{
		limit_name?: string | null;
		metered_feature?: string;
		rate_limit?: CodexLimit | null;
	}>;
};

const WEEK_SECONDS = 7 * 86_400;

const CLAUDE_WINDOWS = [
	["five_hour", "5-hour"],
	["seven_day", "Weekly"],
] as const;

function accountIdFromToken(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof accountId === "string" && accountId) return accountId;
	} catch { /* Invalid token; report a useful error below. */ }
	throw new Error("Pi's Codex login has no ChatGPT account ID; try /login openai-codex again");
}

/** Only weekly windows are shown. */
async function readCodexUsage(token: string): Promise<UsageRow[]> {
	const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountIdFromToken(token),
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(12_000),
	});
	if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status})`);
	const data = await response.json() as CodexUsageResponse;
	const limits = [
		{ label: "Codex", limit: data.rate_limit },
		...(data.additional_rate_limits ?? []).map((item) => ({
			label: item.limit_name ?? (item.metered_feature ?? "additional").replaceAll("_", " "),
			limit: item.rate_limit,
		})),
	];
	return limits.flatMap(({ label, limit }) =>
		[limit?.primary_window, limit?.secondary_window]
			.filter((window): window is CodexWindow => !!window && window.limit_window_seconds >= WEEK_SECONDS)
			.map((window) => ({ label, usedPercent: window.used_percent, resetsAt: window.reset_at })),
	).reverse();
}

async function readClaudeUsage(): Promise<UsageRow[]> {
	const credentialsPath = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
	const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
	const token = credentials?.claudeAiOauth?.accessToken;
	if (typeof token !== "string" || !token.trim()) {
		throw new Error("Claude Code has no OAuth access token; run claude auth login first");
	}

	const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(12_000),
	});
	if (response.status === 401) {
		throw new Error("Claude Code's login has expired; run claude auth login again");
	}
	if (!response.ok) throw new Error(`Claude usage request failed (HTTP ${response.status})`);
	const data = await response.json() as Record<string, { utilization?: number; resets_at?: string | null } | null>;
	return CLAUDE_WINDOWS.flatMap(([id, label]) => {
		const window = data[id];
		if (typeof window?.utilization !== "number") return [];
		return [{ label, usedPercent: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) / 1_000 : undefined }];
	});
}

function relativeTime(timestampSeconds: number): string {
	let seconds = Math.max(0, timestampSeconds - Math.floor(Date.now() / 1_000));
	const days = Math.floor(seconds / 86_400);
	seconds %= 86_400;
	const hours = Math.floor(seconds / 3_600);
	seconds %= 3_600;
	const minutes = Math.floor(seconds / 60);
	return [days ? `${days}d` : "", hours ? `${hours}h` : "", !days && minutes ? `${minutes}m` : ""]
		.filter(Boolean)
		.join(" ") || "now";
}

function resetTime(timestampSeconds: number): string {
	const absolute = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(timestampSeconds * 1_000));
	return `${absolute} (in ${relativeTime(timestampSeconds)})`;
}

function formatRows(title: string, rows: UsageRow[]): string {
	const labelWidth = Math.max(...rows.map(({ label }) => label.length));
	const lines = [title];
	for (const { label, usedPercent, resetsAt } of rows) {
		const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
		const filled = Math.round(remaining / 5);
		const prefix = `  ${label.padEnd(labelWidth)}  `;
		lines.push(`${prefix}[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${remaining.toFixed(0)}% remaining`);
		if (resetsAt !== undefined) lines.push(`${" ".repeat(prefix.length)}↳ resets ${resetTime(resetsAt)}`);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show subscription usage and reset times for the selected provider",
		handler: async (_args, ctx) => {
			const provider = ctx.model?.provider;
			if (provider !== "claude-bridge" && provider !== "openai-codex") {
				ctx.ui.notify("/status supports openai-codex and claude-bridge models.", "info");
				return;
			}
			const name = provider === "claude-bridge" ? "Claude" : "Codex";
			ctx.ui.notify(`Checking ${name} usage…`, "info");
			try {
				if (provider === "claude-bridge") {
					const rows = await readClaudeUsage();
					ctx.ui.notify(rows.length ? formatRows("Claude subscription usage", rows) : "Claude returned no subscription usage windows.", "info");
				} else {
					const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
					if (!token) throw new Error("Sign in with /login openai-codex first");
					const rows = await readCodexUsage(token);
					ctx.ui.notify(rows.length ? formatRows("Weekly usage", rows) : "Codex returned no weekly rate-limit window.", "info");
				}
			} catch (error) {
				ctx.ui.notify(`Could not read ${name} usage: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
