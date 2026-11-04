/**
 * Shows pi-processes state inline in the footer via setStatus(),
 * instead of the package's separate below-editor status widget.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "processes";
const MAX_NAME = 20;
const LIVE = new Set(["running", "terminating", "terminate_timeout"]);

type ProcessInfo = {
	id: string;
	name: string;
	status: string;
	success: boolean | null;
};

function requestList(pi: ExtensionAPI): ProcessInfo[] {
	let list: ProcessInfo[] = [];
	pi.events.emit("processes:request:list", {
		reply: (result: ProcessInfo[]) => {
			list = result;
		},
	});
	return list;
}

function render(ctx: ExtensionContext, processes: ProcessInfo[]): string | undefined {
	if (processes.length === 0) return undefined;
	const { theme } = ctx.ui;
	const parts: string[] = [];
	let done = 0;
	let failed = 0;
	let killed = 0;

	for (const p of processes) {
		if (LIVE.has(p.status)) {
			const name = p.name.length > MAX_NAME ? `${p.name.slice(0, MAX_NAME - 1)}…` : p.name;
			const color = p.status === "running" ? "accent" : "warning";
			parts.push(theme.fg(color, `● ${name}`));
		} else if (p.status === "killed") killed++;
		else if (p.success) done++;
		else failed++;
	}

	if (failed > 0) parts.push(theme.fg("error", `! ${failed} failed`));
	if (killed > 0) parts.push(theme.fg("dim", `■ ${killed} killed`));
	if (done > 0) parts.push(theme.fg("success", "✓") + theme.fg("dim", ` ${done} done`));
	return theme.fg("dim", "ps: ") + parts.join("  ");
}

export default function processesStatusExtension(pi: ExtensionAPI): void {
	let ctxRef: ExtensionContext | undefined;
	let disposers: Array<() => void> = [];

	const refresh = () => {
		if (!ctxRef?.hasUI) return;
		ctxRef.ui.setStatus(STATUS_KEY, render(ctxRef, requestList(pi)));
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		for (const dispose of disposers) dispose();
		disposers = ["processes:started", "processes:ended", "processes:changed"].map((channel) =>
			pi.events.on(channel, refresh),
		);
		refresh();
	});

	pi.on("session_shutdown", () => {
		for (const dispose of disposers) dispose();
		disposers = [];
		ctxRef = undefined;
	});
}
