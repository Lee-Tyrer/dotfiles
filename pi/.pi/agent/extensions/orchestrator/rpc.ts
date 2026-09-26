import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonAgentSessionEvent, RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";

/** Small RPC transport: acknowledgments, LF-only framing, and owned-process cleanup. */
export class WorkerRpc {
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<string, { resolve(response: RpcResponse): void; reject(error: Error): void }>();
	private sequence = 0;
	private exited = false;
	private closing = false;
	private shutdown?: Promise<void>;
	private closed: Promise<void>;
	private stderr = "";

	constructor(
		cli: string,
		args: string[],
		cwd: string,
		onEvent: (event: JsonAgentSessionEvent) => void,
		onExit: (error: Error) => void,
	) {
		this.child = spawn(process.execPath, [cli, "--mode", "rpc", ...args], {
			cwd,
			env: { ...process.env, PI_ORCHESTRATOR_WORKER: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let spawnError: Error | undefined;
		this.child.once("error", (error) => { spawnError = error; });
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (text: string) => { this.stderr = (this.stderr + text).slice(-4000); });
		this.closed = new Promise((resolve) => {
			this.child.once("close", (code, signal) => {
				this.exited = true;
				const error = spawnError ?? new Error(`Worker exited (${signal ?? code}). ${this.stderr}`.trim());
				for (const request of this.pending.values()) request.reject(error);
				this.pending.clear();
				resolve();
				if (!this.closing) onExit(error);
			});
		});
		this.child.stdin.on("error", (error) => {
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
			if (!this.closing) void this.stop().then(() => onExit(error));
		});

		let buffer = "";
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (text: string) => {
			buffer += text;
			let end: number;
			while ((end = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (!line) continue;
				let record;
				try { record = JSON.parse(line); }
				catch { continue; } // Ignore incidental non-protocol diagnostics.
				if (!record || typeof record !== "object") continue;
				if (record.type === "response") {
					this.pending.get(record.id)?.resolve(record as RpcResponse);
				} else if (record.type === "extension_ui_request") {
					// Workers cannot approve dialogs on the user's behalf.
					if (["select", "confirm", "input", "editor"].includes(record.method)) {
						this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true }) + "\n");
					}
				} else {
					onEvent(record as JsonAgentSessionEvent);
				}
			}
		});
	}

	request<T = unknown>(command: RpcCommand, timeoutMs = 15000): Promise<T> {
		if (this.exited || !this.child.stdin.writable) return Promise.reject(new Error("Worker is no longer available; start a new worker."));
		const id = `worker-${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const finish = (error?: Error, response?: RpcResponse) => {
				clearTimeout(timer);
				this.pending.delete(id);
				if (error) reject(error);
				else if (response?.success) resolve(("data" in response ? response.data : undefined) as T);
				else reject(new Error(response && "error" in response ? response.error : "Worker rejected the command."));
			};
			const timer = setTimeout(() => finish(new Error(`Worker did not acknowledge ${command.type}. ${this.stderr}`.trim())), timeoutMs);
			this.pending.set(id, { resolve: (response) => finish(undefined, response), reject: (error) => finish(error) });
			this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n", (error) => {
				if (error) finish(error);
			});
		});
	}

	stop(): Promise<void> {
		if (this.shutdown) return this.shutdown;
		this.closing = true;
		this.shutdown = (async () => {
			if (this.exited) return;
			// Let Pi abort its tools before falling back to terminating the process.
			await this.request({ type: "clear_queue" }, 1000).catch(() => {});
			await this.request({ type: "abort" }, 3000).catch(() => {});
			this.child.stdin.end();
			const terminate = setTimeout(() => this.child.kill("SIGTERM"), 1000);
			const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
			try { await this.closed; }
			finally { clearTimeout(terminate); clearTimeout(kill); }
		})();
		return this.shutdown;
	}
}
