/**
 * Adds a session-scoped Fast mode that requests OpenAI's priority service tier.
 *
 * Fast mode deliberately has no model allowlist. When enabled, every
 * OpenAI-compatible provider request gets `service_tier: "priority"`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

const STATE_ENTRY = "fast-mode-state";
const CODEX_PROVIDER = "openai-codex";
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
}

function getSavedState(ctx: ExtensionContext): FastModeState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (typeof entry.data !== "object" || entry.data === null) continue;

		const data = entry.data as { enabled?: unknown };
		if (typeof data.enabled === "boolean") {
			return { enabled: data.enabled };
		}
	}
	return undefined;
}

function isOpenAICompatibleModel(ctx: ExtensionContext): boolean {
	const api = ctx.model?.api;
	return api === "openai-codex-responses"
		|| api === "openai-responses"
		|| api === "azure-openai-responses"
		|| api === "openai-completions";
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
				if (!state.enabled || model.api !== CODEX_API) {
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

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY, { enabled: fastModeEnabled });
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
		description: "Start with Fast mode enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("fast", {
		description: "Toggle Fast mode (priority service tier)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "warning");
				return;
			}
			toggleFastMode(ctx);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastModeEnabled || !isOpenAICompatibleModel(ctx)) return;
		return applyFastServiceTier(event.payload);
	});

	function syncFromSession(ctx: ExtensionContext): void {
		// A session choice wins over --fast when resuming or navigating branches.
		const enabled = getSavedState(ctx)?.enabled ?? (pi.getFlag("fast") === true);
		setFastMode(enabled);
		installFastModeProvider(ctx);
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});
}
