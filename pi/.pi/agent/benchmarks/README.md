# Provider timing trace

`provider-timing.ts` is an opt-in extension for recording request/stream timing boundaries in Pi and PiG. It is deliberately outside the auto-discovered `extensions/` directory. It writes metrics only: no prompts, payload contents, response text, header values, or credentials.

Load it explicitly and set a log path:

```sh
PI_PIG_TIMING_LOG=/tmp/pi-timings.jsonl PI_PIG_PRODUCT=pi \
  pi --extension ~/.pi/agent/benchmarks/provider-timing.ts

PI_PIG_TIMING_LOG=/tmp/pig-timings.jsonl PI_PIG_PRODUCT=pig \
  pig -e ~/.pi/agent/benchmarks/provider-timing.ts
```

A trace is flushed at `agent_end`, `agent_settled`, or session shutdown. Use a fresh log path per process/run. Keep a real model endpoint out of benchmark runs; use a local mock provider with a fixed response fixture.

## Fields and limits

- `contextToPayloadReadyMs`: `context` hook to `before_provider_request`; a useful request-preparation boundary, not isolated CPU time for each internal step.
- `payloadBytes`: JSON size of the payload object, computed after the request completes; payload contents are never logged.
- `payloadToMessageEndMs`: request-payload hook through the normalized final message. It includes transport and any provider/server time. A no-delay local fixture removes model-generation wait but still includes local transport and event dispatch.
- `agentStartToEndMs` and `turnStartToEndMs`: total extension-observed run/turn duration, including any tool cycles and mock-provider round trips.
- Each `tools[]` record reports assistant-message-end to tool-start, the tool lifecycle (`tool_execution_start` → `tool_execution_end`), and tool-end to next-payload-ready. The lifecycle includes validation, hook dispatch, execution, and result finalization; it is not just the tool function body.
- `payloadToFirstParsedUpdateMs` and `payloadToFirstTextDeltaMs` are null by default; they are recorded only with `PI_PIG_TIMING_TRACE_DELTAS=1`, which subscribes to every update.
- `responseHeadersToFirstParsedUpdateMs` and related fields are populated only when the host emits `after_provider_response`. That hook is before the body is consumed in upstream Pi. The installed PiG 0.2.0 binary did not emit it in the local-fixture check, so these fields were null for PiG.
- Per-delta tracing adds a callback for every update and can materially perturb PiG timings; use it for diagnostics, not performance samples.

The hooks expose normalized messages, not the raw response chunks or parser-internal start/end. Exact parser CPU time requires instrumentation inside each provider parser (or a custom provider that owns that parsing path). Compare identical prompts, prompt files, tool sets, provider API, response bytes, and chunk schedule; report distributions separately by fixture size/type. The trace records tool names and durations only; it does not store tool arguments or results.
