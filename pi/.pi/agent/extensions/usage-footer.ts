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
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
	renderWorkingMessage?: (width: number) => string | undefined;
	private statusIndicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

	override setWorkingStatusIndicator(
		indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0],
	): void {
		this.statusIndicator = indicator;
		super.setWorkingStatusIndicator(indicator);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const indicator = this.statusIndicator;
		if (indicator?.kind !== "working" || hiddenLineCount > 0 || width <= 5) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		const spinner = indicator.renderSpinnerInBorder(width - 5);
		const prefix = spinner ? `${spinner} ` : "";
		const messageWidth = Math.max(0, width - 4 - visibleWidth(prefix));
		const message = this.renderWorkingMessage?.(messageWidth);
		if (message === undefined) return super.renderTopBorder(width, hiddenLineCount);

		// Compose the live label directly into one border row. The normal loader
		// word-wraps its message, which is unsuitable for a sliding viewport.
		const status = prefix + this.borderColor(truncateToWidth(message, messageWidth, ""));
		return (
			this.borderColor("── ") + status +
			this.borderColor(` ${"─".repeat(Math.max(0, width - visibleWidth(status) - 4))}`)
		);
	}

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

type WorkTimerState = {
	startedAt?: number;
	taskTitle?: string;
	titleTransition?: { from: string; startedAt: number };
	titleTransitionTimer?: ReturnType<typeof setInterval>;
	requestRender?: () => void;
	clearWorkedFor?: () => void;
	setWorkedFor?: (duration: number, title?: string) => void;
	setWorkingMessage?: (message?: string) => void;
	timer?: ReturnType<typeof setInterval>;
};

const TASK_TITLE_SLIDE_FRAME_MS = 32;
const TASK_TITLE_SLIDE_DURATION_MS = 1_200;

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

function stopTaskTitleTransition(work: WorkTimerState): void {
	if (work.titleTransitionTimer !== undefined) clearInterval(work.titleTransitionTimer);
	work.titleTransitionTimer = undefined;
	work.titleTransition = undefined;
}

function renderWorkingMessage(work: WorkTimerState, width: number): string | undefined {
	if (work.startedAt === undefined) return undefined;
	const duration = formatDuration(Date.now() - work.startedAt);
	const suffix = work.taskTitle ? ` · ${duration}` : ` for ${duration}`;
	const titleWidth = Math.max(0, width - visibleWidth(suffix));
	if (titleWidth === 0) return truncateToWidth(duration, width, "");

	const to = truncateToWidth(work.taskTitle ?? "Working", titleWidth, "…");
	const transition = work.titleTransition;
	const progress = transition
		? Math.min(1, Math.max(0, (performance.now() - transition.startedAt) / TASK_TITLE_SLIDE_DURATION_MS))
		: 1;
	if (!transition || progress >= 1) return to + suffix;

	const from = truncateToWidth(transition.from, titleWidth, "…");
	const fromWidth = visibleWidth(from);
	const toWidth = visibleWidth(to);
	const easedProgress = progress * progress * (3 - 2 * progress);
	const frameWidth = Math.round(fromWidth + (toWidth - fromWidth) * easedProgress);
	const offset = Math.min(frameWidth, Math.round(Math.max(fromWidth, toWidth) * easedProgress));
	const incoming = truncateToWidth(sliceByColumn(to, 0, offset, true), offset, "", true);
	const outgoingWidth = frameWidth - offset;
	const outgoing = truncateToWidth(sliceByColumn(from, 0, outgoingWidth, true), outgoingWidth, "", true);
	// Ease the title's right edge toward its final width so the timer follows
	// the slide instead of jumping into place when the transition ends.
	return incoming + outgoing + suffix;
}

function updateWorkingMessage(work: WorkTimerState): void {
	if (work.startedAt === undefined) return;
	const duration = formatDuration(Date.now() - work.startedAt);
	work.setWorkingMessage?.(work.taskTitle ? `${work.taskTitle} · ${duration}` : `Working for ${duration}`);
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
		stopTaskTitleTransition(work);
		work.taskTitle = taskTitle.title;
		if (
			taskTitle.transition === true &&
			previousTitle && taskTitle.title && previousTitle !== taskTitle.title &&
			work.startedAt !== undefined
		) {
			work.titleTransition = { from: previousTitle, startedAt: performance.now() };
			work.titleTransitionTimer = setInterval(() => {
				if (!work.titleTransition) return;
				if (performance.now() - work.titleTransition.startedAt >= TASK_TITLE_SLIDE_DURATION_MS) {
					stopTaskTitleTransition(work);
				}
				work.requestRender?.();
			}, TASK_TITLE_SLIDE_FRAME_MS);
		}
		updateWorkingMessage(work);
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
		work.requestRender = undefined;
		work.setWorkingMessage = (message?: string) => ctx.ui.setWorkingMessage(message);
		work.clearWorkedFor = () => ctx.ui.setWidget("work-timer", undefined);
		work.setWorkedFor = (duration, title) => ctx.ui.setWidget("work-timer", createWorkedForWidget(duration, title));
		work.clearWorkedFor();
		installFooter(ctx, () => planModeEnabled, () => fastModeEnabled);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ShipItEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor.placeholder = "What are we building?";
			editor.placeholderStyle = (text) => ctx.ui.theme.fg("dim", text);
			editor.renderWorkingMessage = (width) => renderWorkingMessage(work, width);
			work.requestRender = () => tui.requestRender();
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
		work.startedAt = undefined;
		work.requestRender = undefined;
		work.setWorkingMessage?.();
	});
}
