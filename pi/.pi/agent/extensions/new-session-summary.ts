import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
};

type Totals = Required<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">>;

const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

function addUsage(totals: Totals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.totalTokens += usage.totalTokens ??
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function getTotals(sessionManager: SessionManager): Totals {
	const totals = emptyTotals();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
				addUsage(totals, entry.message.usage);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(totals, entry.usage);
		}
	}
	return totals;
}

function formatTokens(tokens: number): string {
	return new Intl.NumberFormat().format(tokens);
}

function formatSummary(totals: Totals): string {
	return [
		`Previous session: ${formatTokens(totals.totalTokens)} tokens`,
		`(${formatTokens(totals.input)} input, ${formatTokens(totals.output)} output`,
		`${formatTokens(totals.cacheRead)} cache read, ${formatTokens(totals.cacheWrite)} cache write)`,
	].join(" ");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "new" || !event.previousSessionFile) return;

		try {
			const previous = SessionManager.open(event.previousSessionFile);
			const totals = getTotals(previous);
			ctx.ui.notify(formatSummary(totals), "info");
		} catch (error) {
			ctx.ui.notify(`Could not calculate previous-session token usage: ${String(error)}`, "error");
		}
	});
}
