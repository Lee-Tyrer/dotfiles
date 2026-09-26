/**
 * /orchestrate [goal] enables coordination; /orchestrate off stops it.
 * /worker shows progress; /worker stop stops work without reverting changes.
 * Workers are session-owned: reload, exit, and tree navigation stop them.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import {
	getAgentDir, getPackageDir,
	type ExtensionAPI, type ExtensionContext, type JsonAgentSessionEvent, type RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkerRpc } from "./rpc.ts";

const MODEL = "gpt-6-luna";
const STATE = "orchestrator-enabled";
const CONTEXT = "orchestrator-context";
const COORDINATOR = `You are the coordinator. Keep implementation delegated to the worker tool.
- Explore and propose a concrete plan before implementation. Wait for the user's approval. Existing /plan mode must be turned off by the user before starting a worker.
- After approval, maintain TASKS.md in the working directory. Read any existing file first; preserve unrelated tasks. Use numbered Markdown checkboxes, dependency notes, and brief running/review/blocked notes. Include acceptance criteria and relevant validation commands. Only you may tick a task off.
- Dispatch one ready task at a time. Give the worker a self-contained brief: files/symbols, exact behavior, scope limits, acceptance criteria, and existing checks to run. The worker has fresh context, not this conversation.
- The worker shares your checkout. Do not implement or change source files yourself, and do not run mutating validation while it is working. You may maintain TASKS.md. Do not commit, push, reset, or stash unless the user requested it.
- After starting work, finish your turn and wait for its automatic notification. Do not sleep or repeatedly poll. Use status only when useful or asked.
- On completion, call worker status, inspect the actual diff including new files, and verify the relevant checks. Worker output is a report, not proof of correctness. Use send for corrections in the same worker context. Cap correction rounds at two per task; then mark blocked and ask the user.
- Tick off a task only after your review passes, then dispatch the next ready task from the approved plan. Stop when everything is accepted or blocked.
- User corrections take priority: update affected requirements in TASKS.md and send precise guidance to the worker. A question alone does not authorize changes. Stop the worker before a conflicting replan.
- A stopped worker or failed process is not success. Inspect partial changes before retrying. Do not restart stopped work without the user's instruction. After reload/resume, consult TASKS.md and the diff; workers do not survive reload or exit.`;
const WORKER = `You are an implementation worker assigned one task by a coordinator.
Implement only the assigned scope. Follow repository instructions. Do not delegate or launch other agents or background processes.
TASKS.md belongs to the coordinator: read it if useful, but never edit it or mark tasks complete.
Preserve pre-existing changes. Do not commit, push, reset, stash, or change branches unless explicitly assigned.
Run the requested existing validation. Do not add tests unless the task explicitly requests them.
If a requirement is ambiguous or blocked, stop and report the question instead of guessing.
Finish with changed files, the exact checks and their outcomes, and remaining issues. Completion is subject to the coordinator's review.`;

type Phase = "starting" | "running" | "review" | "failed" | "stopped";
interface Worker {
	rpc: WorkerRpc;
	task: string;
	sessionFile: string;
	phase: Phase;
	activity: string;
	output: string;
	error?: string;
	stopping?: boolean;
}

export default function orchestrator(pi: ExtensionAPI): void {
	if (process.env.PI_ORCHESTRATOR_WORKER === "1") return;
	let enabled = false;
	let closing = false;
	let current: Worker | undefined;
	let context: ExtensionContext | undefined;
	let pendingUsage: Usage | undefined;

	function busy(worker = current): boolean {
		return worker?.phase === "starting" || worker?.phase === "running";
	}
	function planning(ctx: ExtensionContext): boolean {
		const saved = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
		return saved?.type === "custom" ? (saved.data as { enabled?: boolean })?.enabled === true : pi.getFlag("plan") === true;
	}
	function updateStatus(): void {
		if (closing || !context) return;
		context.ui.setStatus("orchestrator", enabled
			? `COORDINATOR${current ? ` | worker: ${current.phase}${busy() ? ` (${current.activity})` : ""}` : ""}`
			: undefined);
	}
	function selectTool(): void {
		const tools = pi.getActiveTools();
		if (enabled !== tools.includes("worker")) {
			pi.setActiveTools(enabled ? [...tools, "worker"] : tools.filter((name) => name !== "worker"));
		}
	}
	function status(): string {
		if (!current) return "No worker is attached to this session. TASKS.md is the durable checklist.";
		return [
			`Worker: ${current.phase} (${current.activity})`,
			`Model: openai-codex/${MODEL}, max thinking, fast mode`,
			`Task: ${current.task}`,
			`Full transcript: ${current.sessionFile}`,
			current.error ? `Error: ${current.error}` : "",
			current.output ? `Latest worker report (not independently verified):\n${current.output}` : "",
		].filter(Boolean).join("\n\n");
	}
	function report(worker: Worker): void {
		if (closing || worker.stopping || current !== worker) return;
		updateStatus();
		pi.sendMessage({ customType: "worker-result", content: status(), display: true }, {
			triggerTurn: enabled,
			deliverAs: "followUp",
		});
	}
	function addUsage(usage: Usage): void {
		if (!pendingUsage) {
			pendingUsage = { ...usage, cost: { ...usage.cost } };
			return;
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) pendingUsage[key] += usage[key];
		for (const key of ["reasoning", "cacheWrite1h"] as const) {
			if (usage[key] !== undefined) pendingUsage[key] = (pendingUsage[key] ?? 0) + usage[key]!;
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) pendingUsage.cost[key] += usage.cost[key];
	}
	function event(worker: Worker, event: JsonAgentSessionEvent): void {
		if (current === worker && event.type === "message_end" && event.message.role === "assistant") addUsage(event.message.usage);
		if (current === worker && event.type === "compaction_end" && event.result?.usage) addUsage(event.result.usage);
		if (closing || worker.stopping || current !== worker) return;
		if (event.type === "agent_start") {
			worker.phase = "running";
			worker.activity = "thinking";
		} else if (event.type === "tool_execution_start") {
			worker.activity = event.toolName;
		} else if (event.type === "tool_execution_end") {
			worker.activity = "thinking";
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			worker.output = text.length > 12000 ? `${text.slice(0, 12000)}\n[Truncated; read the full transcript.]` : text;
			worker.error = ["error", "aborted", "length"].includes(message.stopReason)
				? message.errorMessage || `Worker stopped: ${message.stopReason}` : undefined;
		} else if (event.type === "agent_settled" && busy(worker)) {
			worker.phase = worker.error || !worker.output ? "failed" : "review";
			worker.activity = "idle";
			if (!worker.output && !worker.error) worker.error = "Worker ended without a final report.";
			report(worker);
			return;
		} else {
			return;
		}
		updateStatus();
	}
	async function stop(): Promise<void> {
		const worker = current;
		if (!worker) return;
		worker.stopping = true;
		worker.phase = "stopped";
		worker.activity = "stopping";
		updateStatus();
		await worker.rpc.stop();
		worker.activity = "idle";
		updateStatus();
	}
	function requireExecution(ctx: ExtensionContext): void {
		if (closing || !enabled) throw new Error("Enable coordination with /orchestrate first.");
		if (planning(ctx)) throw new Error("Plan mode is read-only. Ask the user to approve the plan and turn /plan off first.");
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("Background workers need a long-lived interactive or RPC session.");
	}
	async function start(task: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
		requireExecution(ctx);
		if (busy()) throw new Error("A worker is already running. Send guidance or stop it before starting another.");
		if (!existsSync(join(ctx.cwd, "TASKS.md"))) throw new Error("Record the approved plan in TASKS.md before starting a worker.");
		await stop();
		signal?.throwIfAborted();
		requireExecution(ctx);
		const directory = join(getAgentDir(), "sessions", "workers", ctx.sessionManager.getSessionId());
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const sessionFile = join(directory, `${randomUUID()}.jsonl`);
		const worker: Worker = {
			task, sessionFile, phase: "starting", activity: "initializing", output: "",
			rpc: new WorkerRpc(join(getPackageDir(), "dist", "cli.js"), [
				"--provider", "openai-codex", "--model", MODEL, "--thinking", "max",
				"--no-extensions", "--extension", join(getAgentDir(), "extensions", "fast-mode.ts"), "--fast",
				"--no-prompt-templates", "--tools", "read,bash,edit,write,grep,find,ls",
				ctx.isProjectTrusted() ? "--approve" : "--no-approve",
				"--session", sessionFile, "--append-system-prompt", WORKER,
			], ctx.cwd, (record) => event(worker, record), (error) => {
				if (closing || worker.stopping || current !== worker) return;
				const wasStarting = worker.phase === "starting";
				worker.phase = "failed";
				worker.activity = "exited";
				worker.error = error.message;
				if (wasStarting) updateStatus(); // The start tool returns this failure itself.
				else report(worker);
			}),
		};
		current = worker;
		updateStatus();
		const abort = () => { void stop(); };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const state = await worker.rpc.request<RpcSessionState>({ type: "get_state" });
			if (state.model?.provider !== "openai-codex" || state.model.id !== MODEL || state.thinkingLevel !== "max") {
				throw new Error("Worker did not select Luna with max thinking; refusing to use a different model.");
			}
			signal?.throwIfAborted();
			requireExecution(ctx);
			if (worker.stopping) throw new Error("Worker startup was stopped.");
			await worker.rpc.request({ type: "prompt", message: `Assigned implementation task:\n\n${task}` });
		} catch (error) {
			await stop();
			worker.phase = "failed";
			worker.error = error instanceof Error ? error.message : String(error);
			updateStatus();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	pi.registerTool({
		name: "worker",
		label: "Worker",
		description: "Control one background Luna max/fast implementation worker in this checkout. start requires task; send requires message and steers a running worker or continues an idle worker. status returns progress/report; stop cancels without undoing changes. Completion wakes you automatically: finish your turn instead of polling, then review before ticking TASKS.md.",
		parameters: Type.Object({
			action: StringEnum(["start", "status", "send", "stop"] as const),
			task: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
			message: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			context = ctx;
			signal?.throwIfAborted();
			if (params.action === "start") {
				if (!params.task?.trim()) throw new Error("start requires a task.");
				await start(params.task.trim(), ctx, signal);
			} else if (params.action === "send") {
				requireExecution(ctx);
				if (!params.message?.trim()) throw new Error("send requires a message.");
				if (!current || current.stopping) throw new Error("No available worker. Start a new worker with a self-contained task.");
				const worker = current;
				worker.phase = "running";
				worker.error = undefined;
				worker.output = "";
				try {
					await worker.rpc.request({ type: "prompt", message: `Coordinator guidance:\n\n${params.message}`, streamingBehavior: "steer" });
				} catch (error) {
					await stop();
					worker.phase = "failed";
					worker.error = error instanceof Error ? error.message : String(error);
					updateStatus();
					throw error;
				}
			} else if (params.action === "stop") {
				await stop();
			}
			updateStatus();
			const usage = pendingUsage;
			pendingUsage = undefined;
			return { content: [{ type: "text", text: status() }], details: { phase: current?.phase, sessionFile: current?.sessionFile }, usage };
		},
	});

	pi.registerCommand("orchestrate", {
		description: "Coordinate Luna workers: /orchestrate [goal], or /orchestrate off",
		handler: async (args, ctx) => {
			context = ctx;
			enabled = args.trim() !== "off";
			pi.appendEntry(STATE, enabled);
			selectTool();
			if (!enabled) {
				await stop();
				if (enabled) return; // A newer command re-enabled coordination during shutdown.
				pi.sendMessage({ customType: "worker-control", content: "The user disabled coordination. Stop dispatching and wait for further instructions; do not continue implementation yourself.", display: false }, { deliverAs: "nextTurn" });
			}
			updateStatus();
			ctx.ui.notify(enabled ? "Coordinator enabled. Use /plan to plan, approve before execution, and /worker to inspect or stop work." : "Coordinator disabled; worker stopped. Existing changes are preserved.", "info");
			if (enabled && args.trim()) pi.sendUserMessage(args.trim(), { deliverAs: "steer" });
		},
	});
	pi.registerCommand("worker", {
		description: "Inspect the worker, or /worker stop to cancel it immediately",
		handler: async (args, ctx) => {
			context = ctx;
			if (args.trim() && args.trim() !== "stop") {
				ctx.ui.notify("Usage: /worker [stop]. Type corrections normally for the coordinator to forward.", "warning");
				return;
			}
			if (args.trim() === "stop") {
				enabled = false;
				pi.appendEntry(STATE, false);
				selectTool();
				await stop();
				if (enabled) return;
				ctx.ui.notify("Worker stopped; coordination paused. Changes are preserved. Use /orchestrate to continue.", "info");
			}
			const text = args.trim() === "stop"
				? `${status()}\n\nThe user stopped coordination. Wait for further instructions; do not restart or continue implementation yourself.`
				: status();
			pi.sendMessage({ customType: "worker-status", content: text, display: true }, { deliverAs: "nextTurn" });
		},
	});

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		const saved = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === STATE);
		enabled = saved?.type === "custom" && saved.data === true;
		selectTool();
		updateStatus();
	});
	pi.on("before_agent_start", () => { selectTool(); });
	pi.on("context", (event) => ({
		messages: [
			...event.messages.filter((message) => message.role !== "custom" || message.customType !== CONTEXT),
			...(enabled ? [{ role: "custom" as const, customType: CONTEXT, content: `${COORDINATOR}\n\nCurrent worker: ${current?.phase ?? "none"}.`, display: false, timestamp: Date.now() }] : []),
		],
	}));
	pi.events.on("plan-mode:changed", (value) => {
		if ((value as { enabled?: boolean })?.enabled && busy()) void stop();
	});
	pi.on("session_before_tree", async () => { await stop(); });
	pi.on("session_tree", (_event, ctx) => {
		current = undefined;
		context = ctx;
		const saved = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === STATE);
		enabled = saved?.type === "custom" && saved.data === true;
		selectTool();
		updateStatus();
	});
	pi.on("session_shutdown", async () => {
		closing = true;
		await stop();
	});
}
