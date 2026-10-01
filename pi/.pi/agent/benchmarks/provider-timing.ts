import { appendFileSync } from "node:fs";

// Opt-in cross-Pi/PiG timing trace. Load explicitly with PI_PIG_TIMING_LOG set.
// The trace records boundaries and sizes only; it never writes prompt text,
// request payloads, response text, headers, or credentials.

type ToolTrace = {
	callId: string;
	name: string | null;
	callAtMs: number | null;
	startAtMs: number | null;
	endAtMs: number | null;
	isError: boolean | null;
};

type RequestTrace = {
	index: number;
	contextAtMs: number | null;
	payloadAtMs: number;
	responseAtMs: number | null;
	messageStartAtMs: number | null;
	firstUpdateAtMs: number | null;
	firstTextDeltaAtMs: number | null;
	messageEndAtMs: number | null;
	payload: unknown;
	responseStatus: number | null;
	updateCount: number | null;
	textDeltaChars: number | null;
	firstUpdateType: string | null;
};

export default function (pi: any) {
	const logPath = process.env.PI_PIG_TIMING_LOG;
	if (!logPath) return;
	const traceDeltas = process.env.PI_PIG_TIMING_TRACE_DELTAS === "1";

	const now = () => Number(process.hrtime.bigint()) / 1_000_000;
	const requests: RequestTrace[] = [];
	const tools: ToolTrace[] = [];
	const toolsByCallId = new Map<string, ToolTrace>();
	const registrationErrors: string[] = [];
	let contextAtMs: number | null = null;
	let current: RequestTrace | null = null;
	let agentStartAtMs: number | null = null;
	let agentEndAtMs: number | null = null;
	let turnStartAtMs: number | null = null;
	let turnEndAtMs: number | null = null;
	let sequence = 0;

	const register = (name: string, handler: (event: any, ctx: any) => void) => {
		try {
			pi.on(name, handler);
		} catch (error) {
			registrationErrors.push(`${name}: ${String(error)}`);
		}
	};

	const getTool = (event: any) => {
		const id = typeof event?.toolCallId === "string" ? event.toolCallId : `tool-${tools.length + 1}`;
		let trace = toolsByCallId.get(id);
		if (!trace) {
			trace = { callId: id, name: null, callAtMs: null, startAtMs: null, endAtMs: null, isError: null };
			toolsByCallId.set(id, trace);
			tools.push(trace);
		}
		if (typeof event?.toolName === "string") trace.name = event.toolName;
		return trace;
	};

	const flush = (reason: string) => {
		if (requests.length === 0 && tools.length === 0 && registrationErrors.length === 0) return;
		const rows = requests.map((request) => {
			let payloadBytes: number | null = null;
			try {
				payloadBytes = Buffer.byteLength(JSON.stringify(request.payload));
			} catch {
				// Log no payload contents if its representation cannot be sized.
			}
			return {
				index: request.index,
				contextToPayloadReadyMs: request.contextAtMs === null ? null : request.payloadAtMs - request.contextAtMs,
				payloadToFirstParsedUpdateMs: request.firstUpdateAtMs === null ? null : request.firstUpdateAtMs - request.payloadAtMs,
				payloadToFirstTextDeltaMs: request.firstTextDeltaAtMs === null ? null : request.firstTextDeltaAtMs - request.payloadAtMs,
				payloadToMessageEndMs: request.messageEndAtMs === null ? null : request.messageEndAtMs - request.payloadAtMs,
				responseHeadersToFirstParsedUpdateMs: request.responseAtMs === null || request.firstUpdateAtMs === null ? null : request.firstUpdateAtMs - request.responseAtMs,
				responseHeadersToMessageEndMs: request.responseAtMs === null || request.messageEndAtMs === null ? null : request.messageEndAtMs - request.responseAtMs,
				firstUpdateToMessageEndMs: request.firstUpdateAtMs === null || request.messageEndAtMs === null ? null : request.messageEndAtMs - request.firstUpdateAtMs,
				firstTextDeltaToMessageEndMs: request.firstTextDeltaAtMs === null || request.messageEndAtMs === null ? null : request.messageEndAtMs - request.firstTextDeltaAtMs,
				payloadBytes,
				responseStatus: request.responseStatus,
				updateCount: request.updateCount,
				textDeltaChars: request.textDeltaChars,
				firstUpdateType: request.firstUpdateType,
				traceDeltas,
				messageCompleted: request.messageEndAtMs !== null,
			};
		});
		const toolRows = tools.map((tool) => {
			const nextRequest = tool.endAtMs === null ? undefined : requests.find((request) => request.payloadAtMs > tool.endAtMs!);
			const assistantRequest = tool.startAtMs === null ? undefined : [...requests].reverse().find((request) => request.messageEndAtMs !== null && request.messageEndAtMs <= tool.startAtMs!);
			return {
				callId: tool.callId,
				name: tool.name,
				assistantMessageEndToExecutionStartMs: assistantRequest?.messageEndAtMs === null || assistantRequest?.messageEndAtMs === undefined || tool.startAtMs === null ? null : tool.startAtMs - assistantRequest.messageEndAtMs,
				executionStartToToolCallHookMs: tool.startAtMs === null || tool.callAtMs === null ? null : tool.callAtMs - tool.startAtMs,
				toolCallHookToExecutionEndMs: tool.callAtMs === null || tool.endAtMs === null ? null : tool.endAtMs - tool.callAtMs,
				executionMs: tool.startAtMs === null || tool.endAtMs === null ? null : tool.endAtMs - tool.startAtMs,
				executionEndToNextPayloadReadyMs: tool.endAtMs === null || !nextRequest ? null : nextRequest.payloadAtMs - tool.endAtMs,
				isError: tool.isError,
			};
		});
		const record = {
			schema: "pi-pig-hook-timing/v1",
			product: process.env.PI_PIG_PRODUCT || "unspecified",
			run: process.env.PI_PIG_RUN_ID || null,
			flushReason: reason,
			writtenAt: new Date().toISOString(),
			agentStartToEndMs: agentStartAtMs === null || agentEndAtMs === null ? null : agentEndAtMs - agentStartAtMs,
			turnStartToEndMs: turnStartAtMs === null || turnEndAtMs === null ? null : turnEndAtMs - turnStartAtMs,
			requests: rows,
			tools: toolRows,
			registrationErrors: registrationErrors.splice(0),
		};
		try {
			appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			console.error(`provider-timing: cannot append ${logPath}: ${String(error)}`);
		}
		requests.length = 0;
		tools.length = 0;
		toolsByCallId.clear();
		current = null;
		contextAtMs = null;
		agentStartAtMs = null;
		agentEndAtMs = null;
		turnStartAtMs = null;
		turnEndAtMs = null;
	};

	register("context", () => {
		contextAtMs = now();
	});

	register("before_provider_request", (event) => {
		current = {
			index: ++sequence,
			contextAtMs,
			payloadAtMs: now(),
			responseAtMs: null,
			messageStartAtMs: null,
			firstUpdateAtMs: null,
			firstTextDeltaAtMs: null,
			messageEndAtMs: null,
			payload: event?.payload,
			responseStatus: null,
			updateCount: traceDeltas ? 0 : null,
			textDeltaChars: traceDeltas ? 0 : null,
			firstUpdateType: null,
		};
		requests.push(current);
		contextAtMs = null;
	});

	register("after_provider_response", (event) => {
		if (!current) return;
		current.responseAtMs = now();
		current.responseStatus = typeof event?.status === "number" ? event.status : null;
	});

	register("message_start", (event) => {
		if (event?.message?.role === "assistant" && current && current.messageStartAtMs === null) {
			current.messageStartAtMs = now();
		}
	});

	if (traceDeltas) {
		register("message_update", (event) => {
			if (event?.message?.role !== "assistant" || !current) return;
			const eventAtMs = now();
			const kind = event?.assistantMessageEvent?.type;
			current.updateCount = (current.updateCount ?? 0) + 1;
			if (current.firstUpdateAtMs === null) {
				current.firstUpdateAtMs = eventAtMs;
				current.firstUpdateType = typeof kind === "string" ? kind : null;
			}
			if (kind === "text_delta" && typeof event?.assistantMessageEvent?.delta === "string") {
				if (current.firstTextDeltaAtMs === null) current.firstTextDeltaAtMs = eventAtMs;
				current.textDeltaChars = (current.textDeltaChars ?? 0) + event.assistantMessageEvent.delta.length;
			}
		});
	}

	register("message_end", (event) => {
		if (event?.message?.role === "assistant" && current) current.messageEndAtMs = now();
	});

	register("agent_start", () => {
		if (agentStartAtMs === null) agentStartAtMs = now();
	});
	register("agent_end", () => {
		agentEndAtMs = now();
		flush("agent_end");
	});
	register("turn_start", () => {
		if (turnStartAtMs === null) turnStartAtMs = now();
	});
	register("turn_end", () => {
		turnEndAtMs = now();
	});
	register("tool_call", (event) => {
		getTool(event).callAtMs = now();
	});
	register("tool_execution_start", (event) => {
		getTool(event).startAtMs = now();
	});
	register("tool_execution_end", (event) => {
		const tool = getTool(event);
		tool.endAtMs = now();
		tool.isError = typeof event?.isError === "boolean" ? event.isError : null;
	});
	register("agent_settled", () => flush("agent_settled"));
	register("session_shutdown", () => flush("session_shutdown"));
}
