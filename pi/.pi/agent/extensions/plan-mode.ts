import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "plan-mode-state";
const PLAN_DISABLED_TOOLS = new Set(["edit", "write", "powershell"]);

// Keep this deliberately conservative. In plan mode, the model should use the
// built-in read/search tools whenever possible, and bash is only a fallback for
// commands that are clearly observational. sd is intentionally excluded because
// it edits files in place.
const READ_ONLY_COMMANDS = [
	/^\s*(?:cat|head|tail|less|more|ls|pwd|grep|rg|fd|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|wc|sort|uniq|diff|eza|bat)(?:\s|$)/i,
	/^\s*git\s+(?:-C\s+\S+\s+)?(?:status|log|diff|show|rev-parse|ls-files)(?:\s|$)/i,
	/^\s*git\s+(?:-C\s+\S+\s+)?branch(?:\s+(?:-a|--all|-r|--remotes|-v|--verbose|-l|--list))?\s*$/i,
	/^\s*git\s+(?:-C\s+\S+\s+)?remote\s+(?:-v|--verbose|show|get-url)(?:\s|$)/i,
	/^\s*git\s+(?:-C\s+\S+\s+)?tag(?:\s+(?:-l|--list))?\s*$/i,
	/^\s*git\s+(?:-C\s+\S+\s+)?config\s+--get(?:-all)?(?:\s|$)/i,
	/^\s*npm\s+(?:list|ls|view|info|search|outdated|audit)(?:\s|$)/i,
	/^\s*yarn\s+(?:list|info|why|audit)(?:\s|$)/i,
	/^\s*node\s+--version\s*$/i,
	/^\s*python(?:3)?\s+--version\s*$/i,
];

function isReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	// Do not try to parse shell syntax here. Reject chaining, redirects,
	// command substitution, and multi-line scripts instead.
	if (/\r|\n|&&|\|\||[;&|<>`]|\$\s*\(/.test(trimmed)) return false;
	if (/^\s*find\b.*\s-(?:exec|execdir|delete|ok|okdir)\b/i.test(trimmed)) return false;
	if (/^\s*(?:npm|yarn|node|python|python3)\b.*(?:--eval|-e\b|install|uninstall|update|upgrade|publish|add|remove|exec)\b/i.test(trimmed)) {
		return false;
	}

	return READ_ONLY_COMMANDS.some((pattern) => pattern.test(trimmed));
}

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

function getSavedState(ctx: ExtensionContext): PlanModeState | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		if (typeof entry.data !== "object" || entry.data === null) continue;

		const data = entry.data as { enabled?: unknown; toolsBeforePlanMode?: unknown };
		if (typeof data.enabled !== "boolean") continue;
		return {
			enabled: data.enabled,
			toolsBeforePlanMode: Array.isArray(data.toolsBeforePlanMode)
				? data.toolsBeforePlanMode.filter((name): name is string => typeof name === "string")
				: undefined,
		};
	}
	return undefined;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in read-only plan mode",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"plan-mode",
			planModeEnabled ? ctx.ui.theme.fg("warning", "PLAN MODE") : undefined,
		);
	}

	function setPlanMode(enabled: boolean): void {
		pi.events.emit("plan-mode:changed", { enabled });
		if (enabled) {
			if (toolsBeforePlanMode === undefined) {
				toolsBeforePlanMode = pi.getActiveTools();
			}
			pi.setActiveTools(pi.getActiveTools().filter((name) => !PLAN_DISABLED_TOOLS.has(name)));
		} else {
			if (toolsBeforePlanMode !== undefined) {
				pi.setActiveTools(toolsBeforePlanMode);
			}
			toolsBeforePlanMode = undefined;
		}
		planModeEnabled = enabled;
	}

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY, {
			enabled: planModeEnabled,
			toolsBeforePlanMode,
		});
	}

	function syncFromSession(ctx: ExtensionContext): void {
		const saved = getSavedState(ctx);
		if (saved?.toolsBeforePlanMode !== undefined) {
			toolsBeforePlanMode = saved.toolsBeforePlanMode;
		}

		// A persisted choice wins once the session has one, including over
		// `--plan` after a reload.
		const enabled = saved?.enabled ?? (pi.getFlag("plan") === true);
		setPlanMode(enabled);
		updateStatus(ctx);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		setPlanMode(!planModeEnabled);
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle read-only plan mode",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /plan", "warning");
				return;
			}
			togglePlanMode(ctx);
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle read-only plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (PLAN_DISABLED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Plan mode is read-only. Disable it with /plan before making changes.",
			};
		}

		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isReadOnlyBashCommand(command)) {
				return {
					block: true,
					reason: `Plan mode only allows clearly read-only bash commands. Disable it with /plan first.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!planModeEnabled) return;

		return {
			systemPrompt: `${event.systemPrompt}

## Plan mode
You are operating in read-only plan mode.

- Explore the repository and inspect relevant files before deciding what is needed.
- Do not edit or write files, and do not run commands that mutate the filesystem, repository, dependencies, or environment.
- When you understand the request, respond with a concrete implementation plan under a heading exactly named "Plan:" followed by numbered steps.
- The plan must be implementation-specific. For every applicable change, explicitly include:
  - the exact files or areas to add, modify, or remove;
  - the function, class, handler, or other symbol names to add or change, plus their responsibilities;
  - the types, interfaces, schemas, and data contracts involved, including important fields and relationships;
  - the code, data, and control-flow logic, including relevant event/lifecycle sequencing and state transitions;
  - assumptions, edge cases, and error-handling behavior;
  - the validation approach, including relevant checks or commands to run and the expected result.
- If a category is not applicable, state that explicitly rather than omitting it.
- Do not claim that changes were made.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});
}
