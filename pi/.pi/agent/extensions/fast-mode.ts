/**
 * Session-scoped Fast mode for Codex models using OpenAI's priority service tier.
 * On by default; /fast toggles it for the current session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "fast-mode-state";

function isFastModel(model: { provider: string } | undefined): boolean {
	return model?.provider === "openai-codex";
}

export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = true;

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		ctx.ui.setStatus("fast-mode", enabled && isFastModel(model) ? ctx.ui.theme.fg("accent", "FAST MODE") : undefined);
	}

	function loadState(ctx: ExtensionContext): void {
		// Entries marked automatic were written by an older version and are not a user choice.
		const saved = ctx.sessionManager.getBranch().findLast((entry) =>
			entry.type === "custom" && entry.customType === STATE_ENTRY && !(entry.data as { automatic?: boolean }).automatic);
		const data = saved?.type === "custom" ? saved.data as { enabled?: boolean } : undefined;
		enabled = data?.enabled ?? true;
		updateStatus(ctx);
	}

	pi.registerCommand("fast", {
		description: "Toggle Codex Fast mode (priority service tier)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			pi.appendEntry(STATE_ENTRY, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(enabled ? "Fast mode enabled (priority service tier)." : "Fast mode disabled.", "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isFastModel(ctx.model)) return;
		return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
	});

	pi.on("session_start", (_event, ctx) => loadState(ctx));
	pi.on("session_tree", (_event, ctx) => loadState(ctx));
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));
}
