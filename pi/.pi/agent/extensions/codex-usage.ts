import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

type RateLimitResponse = {
	rateLimits?: RateLimit;
	rateLimitsByLimitId?: Record<string, RateLimit>;
	rateLimitResetCredits?: { availableCount?: number };
};

function readCodexRateLimits(): Promise<RateLimitResponse> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: child.stdout });
		let stderr = "";
		let settled = false;

		const finish = (error?: Error, result?: RateLimitResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			lines.close();
			child.kill();
			if (error) reject(error);
			else resolve(result ?? {});
		};

		const timeout = setTimeout(() => finish(new Error("Timed out reading Codex usage")), 12_000);
		child.stderr.on("data", (chunk) => {
			if (stderr.length < 4_000) stderr += String(chunk);
		});
		child.once("error", (error) => finish(error));
		child.once("exit", (code) => {
			if (!settled) finish(new Error(stderr.trim() || `Codex app-server exited with code ${code}`));
		});

		lines.on("line", (line) => {
			let message: { id?: number; result?: RateLimitResponse; error?: { message?: string } };
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}

			if (message.id === 1) {
				if (message.error) return finish(new Error(message.error.message || "Could not initialize Codex"));
				child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
				child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2 })}\n`);
			} else if (message.id === 2) {
				if (message.error) return finish(new Error(message.error.message || "Could not read Codex usage"));
				finish(undefined, message.result);
			}
		});

		child.stdin.write(
			`${JSON.stringify({
				method: "initialize",
				id: 1,
				params: { clientInfo: { name: "pi-usage", title: "Pi Usage", version: "1.0.0" } },
			})}\n`,
		);
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

function labelFor(limit: RateLimit): string {
	if (limit.limitName) return limit.limitName;
	if (limit.limitId === "codex") return "Codex";
	return limit.limitId.replaceAll("_", " ");
}

function usageBar(remaining: number): string {
	const filled = Math.round(remaining / 5);
	return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
}

function rateLimits(data: RateLimitResponse): RateLimit[] {
	return data.rateLimitsByLimitId
		? Object.values(data.rateLimitsByLimitId)
		: data.rateLimits
			? [data.rateLimits]
			: [];
}

function formatUsage(data: RateLimitResponse): string {
	const weekly: Array<{ label: string; remaining: number; resetsAt: number }> = [];

	for (const limit of rateLimits(data)) {
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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show weekly Codex usage and reset time",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Checking Codex usage…", "info");
			try {
				ctx.ui.notify(formatUsage(await readCodexRateLimits()), "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not read Codex usage: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
