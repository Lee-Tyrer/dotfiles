import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

const formatTokens = (count: number): string => {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

function usageTotals(ctx: ExtensionContext): { input: number; output: number; hitRate?: number } {
	let input = 0;
	let output = 0;
	let latestAssistantUsage: Usage | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				const usage = (entry.message as AssistantMessage).usage;
				input += usage.input;
				output += usage.output;
				latestAssistantUsage = usage;
			} else if (entry.message.role === "toolResult" && entry.message.usage) {
				input += entry.message.usage.input;
				output += entry.message.usage.output;
			}
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			input += entry.usage.input;
			output += entry.usage.output;
		}
	}

	if (!latestAssistantUsage) return { input, output };
	const promptTokens =
		latestAssistantUsage.input + latestAssistantUsage.cacheRead + latestAssistantUsage.cacheWrite;
	return {
		input,
		output,
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

type WorkTimerState = {
	startedAt?: number;
	clearWorkedFor?: () => void;
	setWorkedFor?: (duration: number) => void;
	setWorkingMessage?: (message?: string) => void;
	timer?: ReturnType<typeof setInterval>;
};

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

function installFooter(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;

	ctx.ui.setFooter((_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const contentWidth = Math.max(0, width - 2);
			const pad = (line: string): string => {
				if (width <= 0) return "";
				if (width === 1) return " ";
				return ` ${truncateToWidth(line, contentWidth, "")} `;
			};
			const { input, output, hitRate } = usageTotals(ctx);
			const context = ctx.getContextUsage();
			const contextText = context?.percent === null || context?.percent === undefined
				? "◉ ?"
				: `◉ ${context.percent.toFixed(1)}%`;
			const hitText = hitRate === undefined ? "⚡?" : `⚡${hitRate.toFixed(1)}%`;
			const model = ctx.model?.id ?? "no model";
			const thinking = ctx.thinkingLevel ?? "off";

			const left = [theme.fg("accent", model), theme.fg("muted", ` (${thinking})`)].join("");
			const right = theme.fg(
				"dim",
				`${contextText}  ${hitText}  ↑ ${formatTokens(input)}  ↓ ${formatTokens(output)}`,
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

function updateWorkingMessage(work: WorkTimerState): void {
	if (work.startedAt === undefined) return;
	work.setWorkingMessage?.(`Working for ${formatDuration(Date.now() - work.startedAt)}`);
}

function createWorkedForWidget(duration: number) {
	return (_tui: unknown, theme: { fg(color: "dim", text: string): string }) => ({
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const worked = theme.fg("dim", ` Worked for ${formatDuration(duration)} `);
			const line = theme.fg("dim", "─".repeat(Math.max(0, width - visibleWidth(worked))));
			return ["", truncateToWidth(worked + line, width, ""), ""];
		},
	});
}

export default function (pi: ExtensionAPI) {
	const work: WorkTimerState = {};

	const stopTimer = () => {
		if (work.timer !== undefined) clearInterval(work.timer);
		work.timer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		work.startedAt = undefined;
		work.setWorkingMessage = (message?: string) => ctx.ui.setWorkingMessage(message);
		work.clearWorkedFor = () => ctx.ui.setWidget("work-timer", undefined);
		work.setWorkedFor = (duration) => ctx.ui.setWidget("work-timer", createWorkedForWidget(duration));
		work.clearWorkedFor();
		installFooter(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ShipItEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor.placeholder = "What are we building?";
			editor.placeholderStyle = (text) => ctx.ui.theme.fg("dim", text);
			return editor;
		});
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
		work.startedAt = undefined;
		work.setWorkingMessage?.();
		work.setWorkedFor?.(duration);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		work.setWorkingMessage?.();
	});
}
