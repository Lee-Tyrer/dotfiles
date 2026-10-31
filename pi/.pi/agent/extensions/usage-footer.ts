/**
 * Adds a TUI footer with model, extension statuses, context, token usage, cache TTL, and work-time details.
 * Also reports the previous session's token usage when a new session starts.
 */
import {
	CustomEditor,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

// Ratios are measured against the usable context before auto-compaction, not
// against the model's raw context window percentage.
const COMPACTION_WARNING_RATIO = 0.9;
const COMPACTION_CRITICAL_RATIO = 0.98;

// Idle time before the provider's prompt cache expires. Providers do not report it, so these are estimates.
const CACHE_TTL_MS: Record<string, number> = {
	"openai-codex": 30 * 60_000,
	"claude-bridge": 60 * 60_000,
};

const formatTokens = (count: number): string => {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

function usageTotals(entries: SessionEntry[]) {
	const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let latest: Usage | undefined;
	const add = (usage: Usage | undefined) => {
		if (!usage) return;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
	};
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			add(entry.message.usage);
			latest = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			add(entry.message.usage);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			add(entry.usage);
		}
	}
	const promptTokens = latest ? latest.input + latest.cacheRead + latest.cacheWrite : 0;
	return {
		...totals,
		total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		hitRate: latest && promptTokens > 0 ? (latest.cacheRead / promptTokens) * 100 : undefined,
	};
}

function previousSessionSummary(sessionFile: string): string {
	const totals = usageTotals(SessionManager.open(sessionFile).getBranch());
	const count = (tokens: number) => tokens.toLocaleString();
	return `Previous session: ${count(totals.total)} tokens (${count(totals.input)} input, ${count(totals.output)} output, `
		+ `${count(totals.cacheRead)} cache read, ${count(totals.cacheWrite)} cache write)`;
}

class ShipItEditor extends CustomEditor {
	placeholder = "";
	placeholderStyle = (text: string): string => text;

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.getText() !== "" || lines.length < 3 || width <= 1 || this.placeholder === "") return lines;

		const firstCharacter = this.placeholder[0]!;
		const remainder = this.placeholder.slice(firstCharacter.length);
		const cursorPlaceholder = `\x1b[7m${firstCharacter}\x1b[0m${this.placeholderStyle(remainder)}`;
		const cursor = "\x1b[7m \x1b[0m";
		lines[1] = truncateToWidth(lines[1]!.replace(cursor, cursorPlaceholder), width, "");
		return lines;
	}
}


type TaskTitleTransition = {
	from: string;
	to: string;
	startedAt: number;
};


type WorkTimerState = {
	ui?: ExtensionContext["ui"];
	startedAt?: number;
	taskTitle?: string;
	titleTransition?: TaskTitleTransition;
	titleTransitionTimer?: ReturnType<typeof setInterval>;
	timer?: ReturnType<typeof setInterval>;
};

type CacheTtlState = {
	// provider/model that answered last, and when its cache is expected to expire.
	model?: string;
	expiresAt?: number;
	pendingModel?: string;
	timer?: ReturnType<typeof setInterval>;
	requestRender?: () => void;
};

const TASK_TITLE_SLIDE_FRAME_MS = 32;
const TASK_TITLE_SLIDE_DURATION_MS = 1_200;
const DEFAULT_TASK_TITLE_VIEWPORT_WIDTH = 80;

const formatDuration = (milliseconds: number): string => {
	const totalSeconds = Math.floor(milliseconds / 1_000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return [hours > 0 ? `${hours}h` : undefined, totalMinutes > 0 ? `${minutes}m` : undefined, `${seconds}s`]
		.filter((part): part is string => part !== undefined)
		.join(" ");
};


function installFooter(ctx: ExtensionContext, cache: CacheTtlState): void {
	if (ctx.mode !== "tui") return;

	// Load the same merged global/project setting Pi uses. The manager is
	// created at session start, so a settings change takes effect after
	// /reload or when the next session starts.
	const { enabled: compactionEnabled, reserveTokens: compactionReserveTokens } =
		SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();

	ctx.ui.setFooter((tui, theme, footerData) => {
		cache.requestRender = () => tui.requestRender();
		return {
			invalidate() {},
			render(width: number): string[] {
				const contentWidth = Math.max(0, width - 2);
				const pad = (line: string): string => {
					if (width <= 0) return "";
					if (width === 1) return " ";
					return ` ${truncateToWidth(line, contentWidth, "")} `;
				};
				const { input, cacheWrite, output, total, hitRate } = usageTotals(ctx.sessionManager.getBranch());
				const context = ctx.getContextUsage();
				const contextPercent = context?.percent === null || context?.percent === undefined
					? "?"
					: `${context.percent.toFixed(1)}%`;
				let contextColor: "dim" | "warning" | "error" = "dim";
				if (compactionEnabled && context?.tokens !== null && context?.tokens !== undefined) {
					const compactionLimit = context.contextWindow - compactionReserveTokens;
					if (compactionLimit > 0) {
						const compactionRatio = context.tokens / compactionLimit;
						if (compactionRatio >= COMPACTION_CRITICAL_RATIO) contextColor = "error";
						else if (compactionRatio >= COMPACTION_WARNING_RATIO) contextColor = "warning";
					}
				}
				const contextIndicator = theme.fg(
					contextColor,
					`${contextColor === "dim" ? "◉" : "⚠"} ${contextPercent}`,
				);
				const hitText = hitRate === undefined ? "⚡?" : `⚡${hitRate.toFixed(1)}%`;
				const model = ctx.model?.id ?? "no model";
				const thinking = ctx.thinkingLevel ?? "off";

				const statuses = [...footerData.getExtensionStatuses().values()].map((status) => ` ${status}`).join("");
				const left = theme.fg("accent", model) + theme.fg("muted", ` (${thinking})`) + statuses;
				const ttlActive = cache.expiresAt !== undefined && cache.model === `${ctx.model?.provider}/${ctx.model?.id}`;
				const remaining = ttlActive ? Math.max(0, cache.expiresAt! - Date.now()) : undefined;
				const ttl = remaining === undefined
					? ""
					: theme.fg(remaining === 0 ? "error" : "dim", `TTL: ${Math.ceil(remaining / 60_000)}m  `);
				const right =
					ttl + contextIndicator +
					theme.fg(
						"dim",
						`  ${hitText}  Σ ${formatTokens(total)}  ↑ ${formatTokens(input + cacheWrite)}  ↓ ${formatTokens(output)}`,
					);
				const gap = Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(right));

				let statsLine: string;
				if (visibleWidth(left) + visibleWidth(right) + 1 <= contentWidth) {
					statsLine = left + " ".repeat(gap) + right;
				} else {
					const rightWidth = Math.min(visibleWidth(right), contentWidth);
					const availableLeft = Math.max(0, contentWidth - rightWidth - 1);
					const clippedLeft = truncateToWidth(left, availableLeft, "");
					statsLine = truncateToWidth(
						clippedLeft +
							" ".repeat(Math.max(1, contentWidth - visibleWidth(clippedLeft) - rightWidth)) +
							right,
						contentWidth,
						"",
					);
				}

				return [pad(statsLine)];
			},
		};
	});
}

function splitTaskTitle(text: string): string[] {
	return Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
		(part) => part.segment,
	);
}

function sliceTaskTitle(text: string, start: number, width: number): string {
	const end = start + width;
	let column = 0;
	let result = "";

	for (const grapheme of splitTaskTitle(text)) {
		const graphemeWidth = visibleWidth(grapheme);
		if (graphemeWidth <= 0) {
			if (column >= start && column < end) result += grapheme;
			continue;
		}

		const nextColumn = column + graphemeWidth;
		if (nextColumn <= start) {
			column = nextColumn;
			continue;
		}
		if (column >= end) break;

		if (column >= start && nextColumn <= end) {
			result += grapheme;
		} else {
			// Avoid splitting a wide grapheme in half as the viewport moves.
			result += " ".repeat(Math.min(nextColumn, end) - Math.max(column, start));
		}
		column = nextColumn;
	}

	return result + " ".repeat(Math.max(0, width - visibleWidth(result)));
}

function easeInOutCubic(value: number): number {
	return value < 0.5
		? 4 * value * value * value
		: 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function renderBillboardPush(
	from: string,
	to: string,
	progress: number,
	viewportWidth: number,
): string {
	const clippedFrom = truncateToWidth(from, viewportWidth, "");
	const clippedTo = truncateToWidth(to, viewportWidth, "");
	const fromWidth = visibleWidth(clippedFrom);
	const toWidth = visibleWidth(clippedTo);
	if (fromWidth <= 0 || toWidth <= 0) return clippedTo;

	const easedProgress = easeInOutCubic(Math.max(0, Math.min(1, progress)));
	const distance = easedProgress * Math.max(fromWidth, toWidth);
	const incomingWidth = Math.min(toWidth, Math.round(distance));
	const oldOffset = Math.round(distance) + (distance > 0 ? 1 : 0);

	let width: number;
	if (toWidth > fromWidth) {
		// Hold the original footprint until the replacement reaches its edge,
		// then grow right one column at a time for the remainder of the summary.
		width = Math.max(fromWidth, incomingWidth);
	} else if (toWidth < fromWidth) {
		// Once the shorter replacement is complete, contract the old footprint
		// while the outgoing prompt continues moving to the right.
		width = Math.max(toWidth, fromWidth - Math.max(0, Math.round(distance - toWidth)));
	} else {
		width = fromWidth;
	}

	const visibleIncomingWidth = Math.min(incomingWidth, width);
	const incoming = sliceTaskTitle(clippedTo, 0, visibleIncomingWidth);
	const oldStart = Math.min(width, Math.max(visibleIncomingWidth, oldOffset));
	const oldVisibleWidth = Math.min(fromWidth, Math.max(0, width - oldStart));
	const outgoing = oldVisibleWidth > 0 ? sliceTaskTitle(clippedFrom, 0, oldVisibleWidth) : "";
	const gap = oldStart - visibleIncomingWidth;
	return (
		incoming +
		" ".repeat(gap) +
		outgoing +
		" ".repeat(Math.max(0, width - visibleWidth(incoming) - gap - visibleWidth(outgoing)))
	);
}

function stopTaskTitleTransition(work: WorkTimerState): void {
	if (work.titleTransitionTimer !== undefined) clearInterval(work.titleTransitionTimer);
	work.titleTransitionTimer = undefined;
	work.titleTransition = undefined;
}

function displayedWorkingMessage(work: WorkTimerState, duration: string): string {
	if (!work.taskTitle) return `Working for ${duration}`;

	const transition = work.titleTransition;
	if (!transition) return `${work.taskTitle} · ${duration}`;

	const elapsed = Date.now() - transition.startedAt;
	if (elapsed >= TASK_TITLE_SLIDE_DURATION_MS) {
		stopTaskTitleTransition(work);
		return `${work.taskTitle} · ${duration}`;
	}

	const from = `${transition.from} · ${duration}`;
	const to = `${transition.to} · ${duration}`;
	const viewportWidth = Math.max(visibleWidth(from), visibleWidth(to));
	return renderBillboardPush(from, to, elapsed / TASK_TITLE_SLIDE_DURATION_MS, viewportWidth);
}

function updateWorkingMessage(work: WorkTimerState): void {
	if (work.startedAt === undefined) return;
	const duration = formatDuration(Date.now() - work.startedAt);
	work.ui?.setWorkingMessage(displayedWorkingMessage(work, duration));
}

function startTaskTitleTransition(work: WorkTimerState, title: string): void {
	const previousTitle = work.taskTitle;
	stopTaskTitleTransition(work);
	work.taskTitle = title;

	if (!previousTitle || previousTitle === title || work.startedAt === undefined) {
		updateWorkingMessage(work);
		return;
	}

	const viewportWidth = Math.max(20, Math.min(DEFAULT_TASK_TITLE_VIEWPORT_WIDTH, (process.stdout.columns ?? 80) - 16));
	const from = truncateToWidth(previousTitle, viewportWidth, "");
	const to = truncateToWidth(title, viewportWidth, "");
	if (!from || !to || from === to) {
		updateWorkingMessage(work);
		return;
	}
	work.titleTransition = {
		from,
		to,
		startedAt: Date.now(),
	};
	updateWorkingMessage(work);
	work.titleTransitionTimer = setInterval(() => {
		if (!work.titleTransition) return;
		if (Date.now() - work.titleTransition.startedAt >= TASK_TITLE_SLIDE_DURATION_MS) {
			stopTaskTitleTransition(work);
		}
		updateWorkingMessage(work);
	}, TASK_TITLE_SLIDE_FRAME_MS);
}

function createWorkedForWidget(duration: number, title?: string) {
	return (_tui: unknown, theme: { fg(color: "dim", text: string): string }) => ({
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const label = title ? `${title} · ${formatDuration(duration)}` : `Worked for ${formatDuration(duration)}`;
			const worked = theme.fg("dim", ` ${label} `);
			const line = theme.fg("dim", "─".repeat(Math.max(0, width - visibleWidth(worked))));
			return ["", truncateToWidth(worked + line, width, ""), ""];
		},
	});
}


export default function (pi: ExtensionAPI) {
	const work: WorkTimerState = {};
	const cache: CacheTtlState = {};

	pi.events.on("task-title:changed", (data) => {
		const { title, transition } = data as { title?: string; transition?: boolean };
		if (transition && title !== undefined && work.taskTitle !== title) {
			startTaskTitleTransition(work, title);
		} else {
			stopTaskTitleTransition(work);
			work.taskTitle = title;
			updateWorkingMessage(work);
		}
	});

	const stopTimer = () => {
		if (work.timer !== undefined) clearInterval(work.timer);
		work.timer = undefined;
	};

	const stopCacheTimer = () => {
		if (cache.timer !== undefined) clearInterval(cache.timer);
		cache.timer = undefined;
	};

	pi.on("session_start", (event, ctx) => {
		stopCacheTimer();
		cache.model = cache.expiresAt = cache.pendingModel = undefined;
		stopTimer();
		stopTaskTitleTransition(work);
		work.startedAt = undefined;
		work.taskTitle = undefined;
		work.ui = ctx.ui;
		ctx.ui.setWidget("work-timer", undefined);
		installFooter(ctx, cache);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ShipItEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor.placeholder = "What are we building?";
			editor.placeholderStyle = (text) => ctx.ui.theme.fg("dim", text);
			return editor;
		});
		if (event.reason === "new" && event.previousSessionFile) {
			ctx.ui.notify(previousSessionSummary(event.previousSessionFile), "info");
		}
	});

	pi.on("session_compact", (event, ctx) => {
		const { total } = usageTotals(ctx.sessionManager.getBranch());
		const kind = event.reason === "threshold"
			? "Auto-compaction"
			: event.reason === "overflow"
				? "Overflow recovery"
				: "Manual compaction";
		ctx.ui.notify(
			`${kind}: ${formatTokens(event.compactionEntry.tokensBefore)} context tokens before compaction · ${formatTokens(total)} tokens used this session`,
			"info",
		);
	});

	pi.on("agent_start", () => {
		if (work.startedAt !== undefined) return;
		work.ui?.setWidget("work-timer", undefined);
		work.startedAt = Date.now();
		updateWorkingMessage(work);
		stopTimer();
		work.timer = setInterval(() => updateWorkingMessage(work), 1_000);
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
		if (CACHE_TTL_MS[message.provider]) cache.pendingModel = `${message.provider}/${message.model}`;
	});

	pi.on("agent_settled", () => {
		if (cache.pendingModel) {
			cache.model = cache.pendingModel;
			cache.expiresAt = Date.now() + CACHE_TTL_MS[cache.pendingModel.split("/")[0]!]!;
			cache.pendingModel = undefined;
			stopCacheTimer();
			// TTLs are whole minutes, so ticking every minute from now lands on each displayed change.
			cache.timer = setInterval(() => {
				cache.requestRender?.();
				if (Date.now() >= cache.expiresAt!) stopCacheTimer();
			}, 60_000);
			cache.requestRender?.();
		}
		if (work.startedAt === undefined) return;
		const duration = Date.now() - work.startedAt;
		stopTimer();
		stopTaskTitleTransition(work);
		work.startedAt = undefined;
		work.ui?.setWorkingMessage();
		work.ui?.setWidget("work-timer", createWorkedForWidget(duration, work.taskTitle));
	});

	pi.on("session_shutdown", () => {
		stopCacheTimer();
		stopTimer();
		stopTaskTitleTransition(work);
		work.ui?.setWorkingMessage();
	});
}
