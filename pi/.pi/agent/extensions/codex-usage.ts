/**
 * Registers /status for Codex or Claude subscription usage.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RateLimitWindow = {
	usedPercent: number;
	windowDurationMins: number;
	resetsAt: number;
};

type RateLimit = {
	limitId: string;
	limitName: string | null;
	primary: RateLimitWindow | null;
	secondary: RateLimitWindow | null;
};

type UsageWindow = {
	used_percent: number;
	limit_window_seconds: number;
	reset_at: number;
};

type UsageLimit = {
	primary_window?: UsageWindow | null;
	secondary_window?: UsageWindow | null;
};

type UsageResponse = {
	rate_limit?: UsageLimit | null;
	additional_rate_limits?: Array<{
		limit_name?: string | null;
		metered_feature?: string;
		rate_limit?: UsageLimit | null;
	}>;
};

function accountIdFromToken(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof accountId === "string" && accountId) return accountId;
	} catch { /* Invalid token; report a useful error below. */ }
	throw new Error("Pi's Codex login has no ChatGPT account ID; try /login openai-codex again");
}

function toRateLimit(limitId: string, limitName: string | null, data?: UsageLimit | null): RateLimit {
	const window = (value?: UsageWindow | null): RateLimitWindow | null => value ? {
		usedPercent: value.used_percent,
		windowDurationMins: value.limit_window_seconds / 60,
		resetsAt: value.reset_at,
	} : null;
	return {
		limitId,
		limitName,
		primary: window(data?.primary_window),
		secondary: window(data?.secondary_window),
	};
}

async function readCodexRateLimits(token: string): Promise<RateLimit[]> {
	const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountIdFromToken(token),
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(12_000),
	});
	if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status})`);
	const data = await response.json() as UsageResponse;
	return [
		toRateLimit("codex", null, data.rate_limit),
		...(data.additional_rate_limits ?? []).map((item) =>
			toRateLimit(item.metered_feature ?? "additional", item.limit_name ?? null, item.rate_limit)),
	];
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

function labelFor(limit: RateLimit): string {
	if (limit.limitName) return limit.limitName;
	if (limit.limitId === "codex") return "Codex";
	return limit.limitId.replaceAll("_", " ");
}

function usageBar(remaining: number): string {
	const filled = Math.round(remaining / 5);
	return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
}

function formatUsage(data: RateLimit[]): string {
	const weekly: Array<{ label: string; remaining: number; resetsAt: number }> = [];

	for (const limit of data) {
		for (const window of [limit.primary, limit.secondary]) {
			if (!window || window.windowDurationMins < 10_080) continue;
			weekly.push({
				label: labelFor(limit),
				remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
				resetsAt: window.resetsAt,
			});
		}
	}

	if (weekly.length === 0) return "Codex returned no weekly rate-limit window.";
	weekly.reverse();

	const labelWidth = Math.max(...weekly.map(({ label }) => label.length));
	const lines = ["Weekly usage"];
	for (const { label, remaining, resetsAt } of weekly) {
		const prefix = `  ${label.padEnd(labelWidth)}  `;
		lines.push(`${prefix}${usageBar(remaining)} ${remaining.toFixed(0)}% remaining`);
		lines.push(`${" ".repeat(prefix.length)}↳ resets ${resetTime(resetsAt)}`);
	}
	return lines.join("\n");
}

type ClaudeUsageWindow = {
	usedPercent?: number;
	resetsAt?: number;
};

const CLAUDE_WINDOWS = [
	["five_hour", "5-hour"],
	["seven_day", "Weekly"],
] as const;

async function readClaudeUsage(): Promise<Map<string, ClaudeUsageWindow>> {
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
	const data = await response.json() as Record<string, {
		utilization?: number;
		resets_at?: string | null;
	} | null>;
	const windows = new Map<string, ClaudeUsageWindow>();
	for (const [id] of CLAUDE_WINDOWS) {
		const window = data[id];
		if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
		const resetsAt = window.resets_at ? Date.parse(window.resets_at) / 1_000 : NaN;
		windows.set(id, {
			usedPercent: window.utilization,
			resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
		});
	}
	return windows;
}

function formatClaudeUsage(windows: Map<string, ClaudeUsageWindow>): string {
	const reported = CLAUDE_WINDOWS.filter(([id]) => windows.get(id)?.usedPercent !== undefined);
	if (reported.length === 0) {
		return "Claude returned no subscription usage windows.";
	}

	const labelWidth = Math.max(...reported.map(([, label]) => label.length));
	const lines = ["Claude subscription usage"];
	for (const [id, label] of reported) {
		const window = windows.get(id)!;
		const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent!));
		const prefix = `  ${label.padEnd(labelWidth)}  `;
		lines.push(`${prefix}${usageBar(remaining)} ${remaining.toFixed(0)}% remaining`);
		if (window.resetsAt !== undefined) {
			lines.push(`${" ".repeat(prefix.length)}resets ${resetTime(window.resetsAt)}`);
		}
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show subscription usage and reset times for the selected provider",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider === "claude-bridge") {
				ctx.ui.notify("Checking Claude usage...", "info");
				try {
					ctx.ui.notify(formatClaudeUsage(await readClaudeUsage()), "info");
				} catch (error) {
					ctx.ui.notify(
						`Could not read Claude usage: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify("/status supports openai-codex and claude-bridge models.", "info");
				return;
			}
			ctx.ui.notify("Checking Codex usage…", "info");
			try {
				const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (!token) throw new Error("Sign in with /login openai-codex first");
				ctx.ui.notify(formatUsage(await readCodexRateLimits(token)), "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not read Codex usage: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
