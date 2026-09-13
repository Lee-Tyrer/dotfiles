/**
 * Adds a TUI footer with model, context, token usage, cache, and work-time details.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	cost?: { total?: number };
};

// Ratios are measured against the usable context before auto-compaction, not
// against the model's raw context window percentage.
const COMPACTION_WARNING_RATIO = 0.9;
const COMPACTION_CRITICAL_RATIO = 0.98;

const formatTokens = (count: number): string => {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

function usageTotals(ctx: ExtensionContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	total: number;
	cost: number;
	hitRate?: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	let reasoningReported = false;
	let cost = 0;
	let latestAssistantUsage: Usage | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				const usage = (entry.message as AssistantMessage).usage;
				input += usage.input;
				output += usage.output;
				cacheRead += usage.cacheRead;
				cacheWrite += usage.cacheWrite;
				if (usage.reasoning !== undefined) {
					reasoning += usage.reasoning;
					reasoningReported = true;
				}
				cost += usage.cost?.total ?? 0;
				latestAssistantUsage = usage;
			} else if (entry.message.role === "toolResult" && entry.message.usage) {
				input += entry.message.usage.input;
				output += entry.message.usage.output;
				cacheRead += entry.message.usage.cacheRead;
				cacheWrite += entry.message.usage.cacheWrite;
				if (entry.message.usage.reasoning !== undefined) {
					reasoning += entry.message.usage.reasoning;
					reasoningReported = true;
				}
				cost += entry.message.usage.cost?.total ?? 0;
			}
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			input += entry.usage.input;
			output += entry.usage.output;
			cacheRead += entry.usage.cacheRead;
			cacheWrite += entry.usage.cacheWrite;
			if (entry.usage.reasoning !== undefined) {
				reasoning += entry.usage.reasoning;
				reasoningReported = true;
			}
			cost += entry.usage.cost?.total ?? 0;
		}
	}

	const total = input + output + cacheRead + cacheWrite;
	if (!latestAssistantUsage) {
		return { input, output, cacheRead, cacheWrite, reasoning: reasoningReported ? reasoning : undefined, total, cost };
	}
	const promptTokens =
		latestAssistantUsage.input + latestAssistantUsage.cacheRead + latestAssistantUsage.cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: reasoningReported ? reasoning : undefined,
		total,
		cost,
		hitRate: promptTokens > 0 ? (latestAssistantUsage.cacheRead / promptTokens) * 100 : undefined,
	};
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
	startedAt?: number;
	taskTitle?: string;
	titleTransition?: TaskTitleTransition;
	titleTransitionTimer?: ReturnType<typeof setInterval>;
	getTaskTitleViewportWidth?: () => number;
	clearWorkedFor?: () => void;
	setWorkedFor?: (duration: number, title?: string) => void;
	setWorkingMessage?: (message?: string) => void;
	timer?: ReturnType<typeof setInterval>;
};

const TASK_TITLE_SLIDE_FRAME_MS = 32;
const TASK_TITLE_SLIDE_DURATION_MS = 1_200;
const DEFAULT_TASK_TITLE_VIEWPORT_WIDTH = 56;

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

function installFooter(
	ctx: ExtensionContext,
	isPlanMode: () => boolean,
	isFastMode: () => boolean,
): void {
	if (ctx.mode !== "tui") return;

	// Load the same merged global/project setting Pi uses. The manager is
	// created at session start, so a settings change takes effect after
	// /reload or when the next session starts.
	const { enabled: compactionEnabled, reserveTokens: compactionReserveTokens } =
		SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();

	ctx.ui.setFooter((_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const contentWidth = Math.max(0, width - 2);
			const pad = (line: string): string => {
				if (width <= 0) return "";
				if (width === 1) return " ";
				return ` ${truncateToWidth(line, contentWidth, "")} `;
			};
			const { input, output, total, hitRate } = usageTotals(ctx);
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

			const plan = isPlanMode() ? theme.fg("warning", " PLAN MODE") : "";
			const fast = isFastMode() ? theme.fg("accent", " FAST MODE") : "";
			const left = [theme.fg("accent", model), theme.fg("muted", ` (${thinking})`), plan, fast].join("");
			const right =
				contextIndicator +
				theme.fg(
					"dim",
					`  ${hitText}  Σ ${formatTokens(total)}  ↑ ${formatTokens(input)}  ↓ ${formatTokens(output)}`,
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
	}));
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
	work.setWorkingMessage?.(displayedWorkingMessage(work, duration));
}

function startTaskTitleTransition(work: WorkTimerState, title: string): void {
	const previousTitle = work.taskTitle;
	stopTaskTitleTransition(work);
	work.taskTitle = title;

	if (!previousTitle || previousTitle === title || work.startedAt === undefined) {
		updateWorkingMessage(work);
		return;
	}

	const viewportWidth = Math.max(
		1,
		work.getTaskTitleViewportWidth?.() ?? DEFAULT_TASK_TITLE_VIEWPORT_WIDTH,
	);
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
	let planModeEnabled = false;
	pi.events.on("plan-mode:changed", (data) => {
		if (typeof data !== "object" || data === null) return;
		const enabled = (data as { enabled?: unknown }).enabled;
		if (typeof enabled === "boolean") planModeEnabled = enabled;
	});
	let fastModeEnabled = false;
	pi.events.on("fast-mode:changed", (data) => {
		if (typeof data !== "object" || data === null) return;
		const enabled = (data as { enabled?: unknown }).enabled;
		if (typeof enabled === "boolean") fastModeEnabled = enabled;
	});

	const work: WorkTimerState = {};
	pi.events.on("task-title:changed", (data) => {
		if (typeof data !== "object" || data === null) return;
		const taskTitle = data as { title?: unknown; transition?: unknown };
		if (taskTitle.title !== undefined && typeof taskTitle.title !== "string") return;
		if (taskTitle.transition !== undefined && typeof taskTitle.transition !== "boolean") return;

		const previousTitle = work.taskTitle;
		if (
			taskTitle.transition === true &&
			typeof taskTitle.title === "string" &&
			previousTitle !== taskTitle.title
		) {
			startTaskTitleTransition(work, taskTitle.title);
		} else {
			stopTaskTitleTransition(work);
			work.taskTitle = taskTitle.title;
			updateWorkingMessage(work);
		}
	});

	const stopTimer = () => {
		if (work.timer !== undefined) clearInterval(work.timer);
		work.timer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		stopTaskTitleTransition(work);
		work.startedAt = undefined;
		work.taskTitle = undefined;
		work.getTaskTitleViewportWidth = () =>
			Math.max(20, Math.min(DEFAULT_TASK_TITLE_VIEWPORT_WIDTH, (process.stdout.columns ?? 80) - 16));
		work.setWorkingMessage = (message?: string) => ctx.ui.setWorkingMessage(message);
		work.clearWorkedFor = () => ctx.ui.setWidget("work-timer", undefined);
		work.setWorkedFor = (duration, title) => ctx.ui.setWidget("work-timer", createWorkedForWidget(duration, title));
		work.clearWorkedFor();
		installFooter(ctx, () => planModeEnabled, () => fastModeEnabled);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ShipItEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor.placeholder = "What are we building?";
			editor.placeholderStyle = (text) => ctx.ui.theme.fg("dim", text);
			return editor;
		});
	});

	pi.on("session_compact", (event, ctx) => {
		const { total } = usageTotals(ctx);
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
		work.clearWorkedFor?.();
		work.startedAt = Date.now();
		updateWorkingMessage(work);
		stopTimer();
		work.timer = setInterval(() => updateWorkingMessage(work), 1_000);
	});

	pi.on("agent_settled", () => {
		if (work.startedAt === undefined) return;
		const duration = Date.now() - work.startedAt;
		stopTimer();
		stopTaskTitleTransition(work);
		work.startedAt = undefined;
		work.setWorkingMessage?.();
		work.setWorkedFor?.(duration, work.taskTitle);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		stopTaskTitleTransition(work);
		work.setWorkingMessage?.();
	});
}
