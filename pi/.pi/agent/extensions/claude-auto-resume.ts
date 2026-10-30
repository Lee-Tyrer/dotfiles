import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PREFIX = "anthropic-ratelimit-unified-";
const BUFFER_MS = 60_000;
const STATUS = "claude-auto-resume";

export default function (pi: ExtensionAPI) {
	let rejectedReset: number | undefined;
	let failed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending: { at: number; session: string; leaf: string | null; model: string } | undefined;
	let statusContext: ExtensionContext | undefined;

	function cancel() {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		pending = undefined;
		rejectedReset = undefined;
		failed = false;
		statusContext?.ui.setStatus(STATUS, undefined);
		statusContext = undefined;
	}

	pi.on("input", () => { cancel(); });
	pi.on("before_agent_start", () => { cancel(); });
	pi.on("agent_start", () => { cancel(); });
	pi.on("model_select", () => { cancel(); });
	pi.on("session_before_switch", () => { cancel(); });
	pi.on("session_tree", () => { cancel(); });
	pi.on("session_shutdown", () => { cancel(); });

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== "claude-bridge") return;
		const headers = event.headers;
		const status = headers[`${PREFIX}status`];
		if (status === undefined) return;
		// A successful request also reports reset headers. Only a rejected five-hour
		// representative claim identifies the window that actually blocked the turn.
		rejectedReset = undefined;
		const claim = headers[`${PREFIX}representative-claim`];
		if (status !== "rejected" || (claim !== "five_hour" && claim !== "5h")) return;
		const seconds = Number(headers[`${PREFIX}reset`] ?? headers[`${PREFIX}5h-reset`]);
		const reset = seconds * 1_000;
		if (Number.isSafeInteger(reset) && reset > 0 && reset + BUFFER_MS > Date.now()) {
			rejectedReset = reset;
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		failed = event.message.stopReason === "error"
			&& /Claude quota exceeded/i.test(event.message.errorMessage ?? "");
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || !failed || rejectedReset === undefined || ctx.model?.provider !== "claude-bridge") {
			cancel();
			return;
		}
		const at = rejectedReset + BUFFER_MS;
		pending = {
			at,
			session: ctx.sessionManager.getSessionId(),
			leaf: ctx.sessionManager.getLeafId(),
			model: ctx.model.id,
		};
		statusContext = ctx;
		ctx.ui.notify(`Claude will resume at ${new Date(at).toLocaleTimeString()} (one minute after reset). /claude-auto-resume cancel to cancel.`, "info");

		const tick = () => {
			const resume = pending;
			if (!resume) return;
			if (ctx.sessionManager.getSessionId() !== resume.session
				|| ctx.sessionManager.getLeafId() !== resume.leaf
				|| ctx.model?.provider !== "claude-bridge" || ctx.model.id !== resume.model
				|| !ctx.isIdle()) {
				cancel();
				return;
			}
			const remaining = resume.at - Date.now();
			if (remaining > 0) {
				const minutes = Math.ceil(remaining / 60_000);
				ctx.ui.setStatus(STATUS, `Claude resumes in ${minutes}m`);
				return;
			}
			cancel();
			pi.sendUserMessage("Continue the task interrupted by the Claude five-hour usage limit. Pick up from the existing conversation.");
		};
		timer = setInterval(tick, 1_000);
		tick();
	});

	pi.registerCommand("claude-auto-resume", {
		description: "Show pending Claude quota resume, or cancel it",
		handler: async (args, ctx) => {
			if (args.trim() === "cancel") {
				const hadPending = pending !== undefined;
				cancel();
				ctx.ui.notify(hadPending ? "Claude auto-resume cancelled." : "No Claude auto-resume pending.", "info");
			} else {
				ctx.ui.notify(pending ? `Claude resumes at ${new Date(pending.at).toLocaleString()}.` : "No Claude auto-resume pending.", "info");
			}
		},
	});
}
