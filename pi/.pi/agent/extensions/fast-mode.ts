/**
 * Adds a session-scoped Fast mode for GPT-6 Luna using OpenAI's priority tier.
 * New chats default to Fast mode when GPT-6 Luna is selected.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

const STATE_ENTRY = "fast-mode-state";
const CODEX_PROVIDER = "openai-codex";
const FAST_MODEL_ID = "gpt-6-luna";
const CODEX_API = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const FAST_MODE_ADAPTER = "__piFastModeAdapter";

interface FastModeAdapter {
    setEnabled(enabled: boolean): void;
}

type FastModeProvider = Provider & {
    [FAST_MODE_ADAPTER]?: FastModeAdapter;
};

type ProviderStreamModel = Parameters<Provider["stream"]>[0];
type ProviderStreamContext = Parameters<Provider["stream"]>[1];
type ProviderStreamOptions = Parameters<Provider["stream"]>[2];

interface FastModeState {
	enabled: boolean;
	automatic: boolean;
}

function getSavedState(ctx: ExtensionContext): FastModeState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (typeof entry.data !== "object" || entry.data === null) continue;

		const data = entry.data as { enabled?: unknown; automatic?: unknown };
		if (typeof data.enabled === "boolean") {
			return { enabled: data.enabled, automatic: data.automatic === true };
		}
	}
	return undefined;
}

function isFastModeModel(model: { provider?: string; id?: string } | undefined): boolean {
	return model?.provider === CODEX_PROVIDER && model.id === FAST_MODEL_ID;
}

function applyFastServiceTier(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	return {
		...(payload as Record<string, unknown>),
		service_tier: FAST_SERVICE_TIER,
	};
}

export default function fastModeExtension(pi: ExtensionAPI): void {
	let fastModeEnabled = false;
	let fastModeProvider: FastModeProvider | undefined;
	let autoFastForNewSession = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"fast-mode",
			fastModeEnabled ? ctx.ui.theme.fg("accent", "FAST MODE") : undefined,
		);
	}

	function setFastMode(enabled: boolean): void {
		fastModeEnabled = enabled;
		fastModeProvider?.[FAST_MODE_ADAPTER]?.setEnabled(enabled);
		pi.events.emit("fast-mode:changed", { enabled });
	}

	function installFastModeProvider(ctx: ExtensionContext): void {
		const registeredProvider = ctx.modelRegistry.getRegisteredNativeProvider(CODEX_PROVIDER) as
			| FastModeProvider
			| undefined;
		if (registeredProvider?.[FAST_MODE_ADAPTER]) {
			fastModeProvider = registeredProvider;
			registeredProvider[FAST_MODE_ADAPTER].setEnabled(fastModeEnabled);
			return;
		}

		const provider = ctx.modelRegistry.getProvider(CODEX_PROVIDER);
		if (!provider) return;
		const existingAdapter = (provider as FastModeProvider)[FAST_MODE_ADAPTER];
		if (existingAdapter) {
			fastModeProvider = provider as FastModeProvider;
			existingAdapter.setEnabled(fastModeEnabled);
			return;
		}

		const state = { enabled: fastModeEnabled };
		const wrappedProvider = {
			...provider,
			stream(
				model: ProviderStreamModel,
				context: ProviderStreamContext,
				options?: ProviderStreamOptions,
			) {
				if (!state.enabled || model.api !== CODEX_API || !isFastModeModel(model)) {
					return provider.stream(model, context, options);
				}
				return provider.stream(model, context, {
					...(options ?? {}),
					serviceTier: FAST_SERVICE_TIER,
				} as ProviderStreamOptions);
			},
		} as FastModeProvider;
		wrappedProvider[FAST_MODE_ADAPTER] = {
			setEnabled: (enabled) => {
				state.enabled = enabled;
			},
		};
		pi.registerProvider(wrappedProvider);
		fastModeProvider = wrappedProvider;
	}

	function persistState(automatic = false): void {
		pi.appendEntry(STATE_ENTRY, { enabled: fastModeEnabled, automatic });
	}

	function toggleFastMode(ctx: ExtensionContext): void {
		setFastMode(!fastModeEnabled);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(
			fastModeEnabled
				? "Fast mode enabled (priority service tier)."
				: "Fast mode disabled.",
			"info",
		);
	}

	pi.registerFlag("fast", {
		description: "Start with Fast mode enabled for GPT-6 Luna",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("fast", {
		description: "Toggle GPT-6 Luna Fast mode (priority service tier)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "warning");
				return;
			}
			toggleFastMode(ctx);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastModeEnabled || !isFastModeModel(ctx.model)) return;
		return applyFastServiceTier(event.payload);
	});

	function syncFromSession(ctx: ExtensionContext, useModelDefault = false): void {
		// A saved session choice wins; otherwise new chats default to Fast only for GPT-6 Luna.
		const savedState = getSavedState(ctx);
		const enabled = savedState?.enabled
			?? (pi.getFlag("fast") === true || (useModelDefault && isFastModeModel(ctx.model)));
		autoFastForNewSession = useModelDefault;
		setFastMode(enabled);
		if (useModelDefault && !savedState) persistState(true);
		installFastModeProvider(ctx);
		updateStatus(ctx);
	}

	pi.on("session_start", async (event, ctx) => {
		syncFromSession(ctx, event.reason === "new" || event.reason === "startup");
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx, autoFastForNewSession);
	});

	pi.on("model_select", (event, ctx) => {
		if (!autoFastForNewSession) return;
		const savedState = getSavedState(ctx);
		if (savedState && !savedState.automatic) return;

		setFastMode(pi.getFlag("fast") === true || isFastModeModel(event.model));
		persistState(true);
		updateStatus(ctx);
	});
}
