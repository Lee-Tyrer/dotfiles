import type {
  AgentToolResult,
  ExtensionAPI,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";

const GREP_MAX_BYTES = 8 * 1024;
const GREP_DEFAULT_LIMIT = 40;
const FIND_MAX_BYTES = 5 * 1024;
const FIND_DEFAULT_LIMIT = 100;
const STALE_TOOL_MAX_BYTES = 8 * 1024;
const MAX_GREP_CONTEXT = 2;
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "generated",
  "cache",
]);
const GREP_EXCLUDE_GLOB =
  "!**/{node_modules,.git,dist,build,coverage,.next,vendor,generated,cache}/**";

const PATH_RECOVERY_MAX_DEPTH = 3;
const PATH_RECOVERY_MAX_VISITED = 500;
const PATH_RECOVERY_MAX_CANDIDATES = 16;
const PATH_RECOVERY_MAX_PARENT_ENTRIES = 32;
const PATH_RECOVERY_MAX_BYTES = 2 * 1024;
const PATH_RECOVERY_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

interface PathRecoveryUnique {
  kind: "unique";
  path: string;
}

interface PathRecoveryMultiple {
  kind: "multiple";
  parent: string;
  missing: string[];
  paths: string[];
  complete: boolean;
  entries: string[];
}

interface PathRecoveryNone {
  kind: "none";
  parent: string;
  missing: string[];
  complete: boolean;
  entries: string[];
}

type PathRecovery = PathRecoveryUnique | PathRecoveryMultiple | PathRecoveryNone;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return /path not found|no such file or directory|cannot find (?:the )?(?:path|file|directory)|not a directory|os error 2\b/i.test(
    errorText(error),
  );
}

function resolveRecoveryPath(input: string, cwd: string): string {
  let normalized = input.replace(PATH_RECOVERY_UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Let the original tool error stand for malformed file URLs.
    }
  }
  return resolve(cwd, normalized || ".");
}

function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  const insideCwd =
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  return (insideCwd ? relativePath || "." : path).replaceAll("\\", "/");
}

function hasPathPattern(path: string): boolean {
  return path.includes("*") || path.includes("?") || path.includes("[") || path.includes("]");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

async function findRecoveryRoot(
  target: string,
): Promise<{ parent: string; missing: string[]; targetIsFile: boolean } | undefined> {
  let cursor = target;
  const missing: string[] = [];
  let targetIsFile = false;

  while (true) {
    try {
      const info = await stat(cursor);
      if (info.isDirectory()) {
        return { parent: cursor, missing, targetIsFile };
      }
      if (cursor === target) targetIsFile = true;
      const name = basename(cursor);
      if (name) missing.unshift(name);
    } catch {
      const name = basename(cursor);
      if (name) missing.unshift(name);
    }

    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function readRecoveryEntries(
  parent: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  throwIfAborted(signal);
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const output: string[] = [];
    let bytes = 0;
    for (const entry of entries.slice(0, PATH_RECOVERY_MAX_PARENT_ENTRIES)) {
      const line = `${entry.name}${entry.isDirectory() ? "/" : ""}`;
      const lineBytes = utf8Bytes(line) + (output.length === 0 ? 0 : 1);
      if (bytes + lineBytes > PATH_RECOVERY_MAX_BYTES) break;
      output.push(line);
      bytes += lineBytes;
    }
    if (entries.length > output.length) output.push("[… more entries omitted]");
    return output;
  } catch {
    return [];
  }
}

async function findRecoveryCandidates(
  parent: string,
  wantedName: string,
  signal: AbortSignal | undefined,
): Promise<{ paths: string[]; complete: boolean }> {
  const wanted = wantedName.toLowerCase();
  const paths: string[] = [];
  let visited = 0;
  let complete = true;

  async function walk(directory: string, depth: number): Promise<void> {
    throwIfAborted(signal);
    if (depth >= PATH_RECOVERY_MAX_DEPTH || paths.length >= PATH_RECOVERY_MAX_CANDIDATES) return;
    if (visited >= PATH_RECOVERY_MAX_VISITED) {
      complete = false;
      return;
    }
    visited++;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }

    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isDirectory()) continue;

      const child = join(directory, entry.name);
      if (entry.name.toLowerCase() === wanted) paths.push(child);
      if (paths.length >= PATH_RECOVERY_MAX_CANDIDATES) {
        complete = false;
        return;
      }

      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await walk(child, depth + 1);
        if (!complete && visited >= PATH_RECOVERY_MAX_VISITED) return;
      }
    }
  }

  await walk(parent, 0);
  return { paths, complete };
}

async function recoverMissingPath(
  rawPath: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<PathRecovery | undefined> {
  if (!rawPath.trim() || hasPathPattern(rawPath)) return undefined;

  const target = resolveRecoveryPath(rawPath, cwd);
  const root = await findRecoveryRoot(target);
  if (!root || root.missing.length === 0 || root.targetIsFile) return undefined;

  const wantedName = root.missing[root.missing.length - 1];
  if (!wantedName) return undefined;

  const [{ paths, complete }, entries] = await Promise.all([
    findRecoveryCandidates(root.parent, wantedName, signal),
    readRecoveryEntries(root.parent, signal),
  ]);
  const uniquePaths = [...new Set(paths)];

  if (complete) {
    const caseSensitive = uniquePaths.filter((path) => basename(path) === wantedName);
    if (caseSensitive.length === 1) return { kind: "unique", path: caseSensitive[0]! };
    if (caseSensitive.length === 0 && uniquePaths.length === 1) {
      return { kind: "unique", path: uniquePaths[0]! };
    }
  }

  if (uniquePaths.length > 0) {
    return {
      kind: "multiple",
      parent: root.parent,
      missing: root.missing,
      paths: uniquePaths,
      complete,
      entries,
    };
  }

  return {
    kind: "none",
    parent: root.parent,
    missing: root.missing,
    complete,
    entries,
  };
}

function formatRecoveryHint(recovery: PathRecovery, cwd: string, rawPath?: string): string {
  const parent = displayPath(recovery.kind === "unique" ? dirname(recovery.path) : recovery.parent, cwd);
  const requested = rawPath ? `\nRequested path: ${JSON.stringify(rawPath)}` : "";
  if (recovery.kind === "unique") {
    return `[Path recovery: ${JSON.stringify(rawPath ?? "the requested path")} → ${displayPath(recovery.path, cwd)} (unique matching directory)]`;
  }

  const missing = recovery.missing.join("/");
  const leaf = recovery.missing[recovery.missing.length - 1] ?? missing;
  if (recovery.kind === "multiple") {
    const paths = recovery.paths
      .slice(0, PATH_RECOVERY_MAX_CANDIDATES)
      .map((path) => `  ${displayPath(path, cwd)}`)
      .join("\n");
    return [
      `Automatic path recovery found multiple directories named ${leaf} in search root ${parent}:${requested}`,
      paths,
      recovery.complete ? "Choose the intended path explicitly." : "Search was bounded; choose the intended path explicitly.",
    ].join("\n");
  }

  const entries = recovery.entries.length
    ? `\nImmediate contents:\n${recovery.entries.join("\n")}`
    : "";
  return [
    `No unique directory named ${leaf} was found in search root ${parent}${requested}`,
    recovery.complete ? "The search was bounded to nearby directories." : "The nearby search was truncated.",
    entries,
  ].join("\n");
}

function addRecoveryNotice<T>(result: T, notice: string): T {
  if (typeof result !== "object" || result === null) return result;
  const candidate = result as { content?: unknown };
  if (!Array.isArray(candidate.content)) return result;

  const content = [...candidate.content];
  const textIndex = content.findIndex(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text",
  );
  if (textIndex === -1) {
    content.unshift({ type: "text", text: notice });
  } else {
    const part = content[textIndex] as { type: "text"; text?: string };
    content[textIndex] = { ...part, text: `${notice}\n${part.text ?? ""}` };
  }

  return { ...result, content } as T;
}

async function executeWithPathRecovery<
  TParams extends { path?: string },
  TResult,
>(
  params: TParams,
  cwd: string,
  signal: AbortSignal | undefined,
  execute: (params: TParams) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await execute(params);
  } catch (error) {
    if (!isMissingPathError(error) || typeof params.path !== "string") throw error;

    const recovery = await recoverMissingPath(params.path, cwd, signal);
    if (!recovery) throw error;

    if (recovery.kind === "unique") {
      try {
        const retried = await execute({ ...params, path: recovery.path });
        return addRecoveryNotice(retried, formatRecoveryHint(recovery, cwd, params.path));
      } catch (retryError) {
        throw new Error(
          `${errorText(error)}\n\n${formatRecoveryHint(recovery, cwd, params.path)}\nRetry also failed: ${errorText(retryError)}`,
        );
      }
    }

    throw new Error(`${errorText(error)}\n\n${formatRecoveryHint(recovery, cwd, params.path)}`);
  }
}

interface ContextEfficiencyDetails {
  kind: "grep" | "find";
  query: string;
  path: string;
  glob?: string;
  generic: boolean;
}

function withContextEfficiencyDetails<T extends { details?: unknown }>(
  result: T,
  details: ContextEfficiencyDetails,
): T {
  const existing =
    typeof result.details === "object" && result.details !== null
      ? result.details
      : {};
  return { ...result, details: { ...existing, contextEfficiency: details } };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateCompleteLines(text: string, maxBytes: number): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of text.split("\n")) {
    const lineBytes = utf8Bytes(line) + (kept.length === 0 ? 0 : 1);
    if (bytes + lineBytes > maxBytes) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return kept.join("\n");
}

function isExcludedResultPath(resultPath: string): boolean {
  return resultPath
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => EXCLUDED_DIRECTORIES.has(part));
}

interface GrepOutputLine {
  path: string;
  line: number;
  match: boolean;
  text: string;
  original: string;
}

function parseGrepOutputLine(line: string): GrepOutputLine | undefined {
  const parsed = /^(.*)(?::(\d+):|-(\d+)-) (.*)$/.exec(line);
  if (!parsed) return undefined;
  const lineNumber = Number(parsed[2] ?? parsed[3]);
  if (!Number.isSafeInteger(lineNumber)) return undefined;
  return {
    path: parsed[1],
    line: lineNumber,
    match: parsed[2] !== undefined,
    text: parsed[4],
    original: line,
  };
}

function mergeGrepOutput(text: string): {
  text: string;
  matches: GrepOutputLine[];
} {
  const output: string[] = [];
  const positions = new Map<string, number>();
  const matches: GrepOutputLine[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseGrepOutputLine(line);
    if (!parsed) {
      output.push(line);
      continue;
    }
    const key = `${parsed.path}\0${parsed.line}`;
    const previousPosition = positions.get(key);
    if (previousPosition === undefined) {
      positions.set(key, output.length);
      output.push(line);
      if (parsed.match) matches.push(parsed);
      continue;
    }
    const previous = parseGrepOutputLine(output[previousPosition]);
    if (parsed.match && previous && !previous.match) {
      output[previousPosition] = line;
      matches.push(parsed);
    }
  }
  return { text: output.join("\n"), matches };
}

function compactBroadGrep(
  text: string,
  details: ContextEfficiencyDetails,
  matchLimitReached: boolean,
): string {
  const merged = mergeGrepOutput(text);
  const fileCounts = new Map<string, number>();
  for (const match of merged.matches)
    fileCounts.set(match.path, (fileCounts.get(match.path) ?? 0) + 1);
  const topFiles = [...fileCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  const count = `${merged.matches.length}${matchLimitReached ? "+" : ""}`;
  const files = topFiles.length
    ? `\n\nFiles with most observed matches:\n${topFiles.map(([file, matches]) => `  ${file}  ${matches}`).join("\n")}`
    : "";
  return `Search too broad: ${count} matches across ${fileCounts.size} observed files.${files}\n\nQuery: ${details.query}\nPath: ${details.path}\nFull raw result remains in session history.\nRefine the search by directory, filename/glob, or search term.`;
}

function replaceTextContent(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  text: string,
): AgentMessage {
  return { ...message, content: [{ type: "text", text }] };
}

function messageText(
  message: Extract<AgentMessage, { role: "toolResult" }>,
): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contextEfficiencyDetails(
  message: Extract<AgentMessage, { role: "toolResult" }>,
): ContextEfficiencyDetails | undefined {
  if (typeof message.details !== "object" || message.details === null)
    return undefined;
  const details = (message.details as { contextEfficiency?: unknown })
    .contextEfficiency;
  if (typeof details !== "object" || details === null) return undefined;
  const candidate = details as Partial<ContextEfficiencyDetails>;
  if (
    (candidate.kind !== "grep" && candidate.kind !== "find") ||
    typeof candidate.query !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.generic !== "boolean"
  )
    return undefined;
  return candidate as ContextEfficiencyDetails;
}

interface ToolCallMetadata {
  name: string;
  arguments: Record<string, unknown>;
}

function collectToolCalls(messages: AgentMessage[]): Map<string, ToolCallMetadata> {
  const calls = new Map<string, ToolCallMetadata>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const args =
        typeof part.arguments === "object" && part.arguments !== null
          ? (part.arguments as Record<string, unknown>)
          : {};
      calls.set(part.id, { name: part.name, arguments: args });
    }
  }
  return calls;
}

function historicalSearchDetails(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  call: ToolCallMetadata | undefined,
  cwd: string,
): ContextEfficiencyDetails | undefined {
  if ((message.toolName !== "grep" && message.toolName !== "find") || !call)
    return undefined;
  const queryValue = call.arguments.pattern;
  if (typeof queryValue !== "string") return undefined;
  const pathValue = call.arguments.path;
  const globValue = call.arguments.glob;
  return {
    kind: message.toolName,
    query: queryValue,
    path: typeof pathValue === "string" ? pathValue : cwd,
    ...(typeof globValue === "string" ? { glob: globValue } : {}),
    generic: pathValue === undefined && globValue === undefined,
  };
}

export function transformWorkingContext(
  messages: AgentMessage[],
  cwd = ".",
): AgentMessage[] {
  const toolCalls = collectToolCalls(messages);
  const recentToolResults = new Set<number>();
  for (
    let index = messages.length - 1;
    index >= 0 && messages[index]?.role === "toolResult";
    index--
  )
    recentToolResults.add(index);
  let compacted = 0;
  let rawBytes = 0;
  let visibleBytes = 0;

  const transformed = messages.map((message, index): AgentMessage => {
    if (message.role === "bashExecution") {
      const bytes = utf8Bytes(message.output);
      rawBytes += bytes;
      if (index !== messages.length - 1 && bytes > STALE_TOOL_MAX_BYTES) {
        compacted++;
        const replacement = `[Older shell output omitted from active context.\nCommand: ${message.command}\nExit code: ${message.exitCode ?? "unknown"}\nFull raw result remains in session history.]`;
        visibleBytes += utf8Bytes(replacement);
        return { ...message, output: replacement, truncated: true };
      }
      visibleBytes += bytes;
      return message;
    }
    if (message.role !== "toolResult") return message;
    const rawText = messageText(message);
    rawBytes += utf8Bytes(rawText);
    const call = toolCalls.get(message.toolCallId);
    const metadata =
      contextEfficiencyDetails(message) ??
      historicalSearchDetails(message, call, cwd);
    if (metadata?.kind === "grep") {
      const merged = mergeGrepOutput(rawText);
      const matchLimitReached =
        typeof message.details === "object" &&
        message.details !== null &&
        "matchLimitReached" in message.details;
      if (utf8Bytes(merged.text) > GREP_MAX_BYTES) {
        compacted++;
        const replacement = compactBroadGrep(
          merged.text,
          metadata,
          matchLimitReached,
        );
        visibleBytes += utf8Bytes(replacement);
        return replaceTextContent(message, replacement);
      }
      visibleBytes += utf8Bytes(merged.text);
      return merged.text === rawText
        ? message
        : replaceTextContent(message, merged.text);
    }
    if (metadata?.kind === "find") {
      const filtered = metadata.generic
        ? rawText
            .split("\n")
            .filter((line) => !isExcludedResultPath(line))
            .join("\n")
        : rawText;
      if (utf8Bytes(filtered) > FIND_MAX_BYTES) {
        compacted++;
        const bounded = truncateCompleteLines(filtered, FIND_MAX_BYTES - 256);
        const replacement = `${bounded}\n\n[Find output limited to 5KB. Refine the path or glob. Full raw result remains in session history.]`;
        visibleBytes += utf8Bytes(replacement);
        return replaceTextContent(message, replacement);
      }
      visibleBytes += utf8Bytes(filtered);
      return filtered === rawText
        ? message
        : replaceTextContent(message, filtered);
    }
    if (
      !recentToolResults.has(index) &&
      (message.toolName === "bash" ||
        message.toolName === "ls" ||
        message.toolName === "find" ||
        message.toolName === "grep") &&
      utf8Bytes(rawText) > STALE_TOOL_MAX_BYTES
    ) {
      compacted++;
      const command =
        message.toolName === "bash" && typeof call?.arguments.command === "string"
          ? `\nCommand: ${call.arguments.command}`
          : "";
      const replacement = `[Older ${message.toolName} result omitted from active context.${command}\nStatus: ${message.isError ? "failed" : "succeeded"}\nFull raw result remains in session history. Rerun the command or search if exact output is needed.]`;
      visibleBytes += utf8Bytes(replacement);
      return replaceTextContent(message, replacement);
    }
    visibleBytes += utf8Bytes(rawText);
    return message;
  });

  if (process.env.PI_CONTEXT_EFFICIENCY_DEBUG === "1") {
    process.stderr.write(
      `[context-efficiency] rawToolBytes=${rawBytes} visibleToolBytes=${visibleBytes} compacted=${compacted}\n`,
    );
  }
  return transformed;
}

const toolsByCwd = new Map<string, ReturnType<typeof createTools>>();
const MODERN_TOOL_PATH_PREFIX = 'export PATH="$HOME/.pi/agent/bin:$PATH"';

function createTools(cwd: string) {
  return {
    bash: createBashTool(cwd, { commandPrefix: MODERN_TOOL_PATH_PREFIX }),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
    read: createReadTool(cwd),
    write: createWriteTool(cwd),
  };
}

function getTools(cwd: string) {
  let tools = toolsByCwd.get(cwd);
  if (!tools) {
    tools = createTools(cwd);
    toolsByCwd.set(cwd, tools);
  }
  return tools;
}

function textOutput(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return (
    result.content.find((part) => part.type === "text")?.text?.trim() ?? ""
  );
}

function countLines(text: string): number {
  return text === ""
    ? 0
    : text.split("\n").filter((line) => line.trim() !== "").length;
}

function expandedOutput(
  output: string,
  theme: { fg(color: "toolOutput", text: string): string },
): Text {
  if (!output) return new Text("", 0, 0);
  return new Text(
    `\n${output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n")}`,
    0,
    0,
  );
}

export default function (pi: ExtensionAPI) {
  const initial = getTools(process.cwd());
  const builtInRead = createReadToolDefinition(process.cwd());

  pi.registerTool({
    name: "read",
    label: "read",
    description: initial.read.description,
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use read to examine files; use sd for simple regex substitutions.",
    ],
    parameters: initial.read.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).read.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme) {
      const range =
        args.offset !== undefined || args.limit !== undefined
          ? theme.fg(
              "dim",
              ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`,
            )
          : "";
      return new Text(
        theme.fg("toolTitle", "› Read ") +
          theme.fg("accent", args.path || "…") +
          range,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial)
        return new Text(theme.fg("dim", "  Reading…"), 0, 0);
      const hasImage = result.content.some((part) => part.type === "image");
      if ((options.expanded || hasImage) && builtInRead.renderResult) {
        return builtInRead.renderResult(
          result as AgentToolResult<ReadToolDetails | undefined>,
          options,
          theme,
          context,
        );
      }
      const output = result.content.find((part) => part.type === "text");
      if (context.isError)
        return new Text(theme.fg("error", "  ✗ Read failed"), 0, 0);
      const lines =
        output?.type === "text" && output.text !== ""
          ? output.text.split("\n").length
          : 0;
      return new Text(
        theme.fg("dim", `  ✓ ${lines} line${lines === 1 ? "" : "s"}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: initial.ls.description,
    promptSnippet: "List directory contents",
    parameters: initial.ls.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      return executeWithPathRecovery(
        params,
        ctx.cwd,
        signal,
        (nextParams) => getTools(ctx.cwd).ls.execute(id, nextParams, signal, onUpdate),
      );
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", "› List ") + theme.fg("accent", args.path || "."),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "  Listing…"), 0, 0);
      const output = textOutput(result);
      if (expanded) return expandedOutput(output, theme);
      if (context.isError)
        return new Text(theme.fg("error", "  ✗ List failed"), 0, 0);
      const count = countLines(output);
      return new Text(
        theme.fg("dim", `  ✓ ${count} entr${count === 1 ? "y" : "ies"}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: initial.write.description,
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: initial.write.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).write.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme) {
      const lines = args.content === "" ? 0 : args.content.split("\n").length;
      return new Text(
        theme.fg("toolTitle", "› Write ") +
          theme.fg("accent", args.path || "…") +
          theme.fg("dim", ` · ${lines} line${lines === 1 ? "" : "s"}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "  Writing…"), 0, 0);
      const output = textOutput(result);
      if (expanded) return expandedOutput(output, theme);
      return new Text(
        context.isError
          ? theme.fg("error", "  ✗ Write failed")
          : theme.fg("dim", "  ✓ Written"),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: initial.bash.description,
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: [
      "You can inspect PI_* environment variables for current model and session details.",
    ],
    parameters: initial.bash.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).bash.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme) {
      const command = (args.command || "…").replace(/\s+/g, " ").trim();
      return new Text(
        theme.fg("toolTitle", "› Run ") +
          theme.fg("muted", truncateToWidth(command, 88, "…")),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "  Running…"), 0, 0);
      const output = textOutput(result);
      if (expanded) return expandedOutput(output, theme);
      const lines = countLines(output);
      const suffix =
        lines > 0 ? ` · ${lines} line${lines === 1 ? "" : "s"}` : "";
      return new Text(
        context.isError
          ? theme.fg("error", `  ✗ Failed${suffix}`)
          : theme.fg("dim", `  ✓ Done${suffix}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: initial.find.description,
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    parameters: initial.find.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      const generic = params.path === undefined;
      const effectiveParams = {
        ...params,
        limit: Math.max(1, params.limit ?? FIND_DEFAULT_LIMIT),
      };
      const result = await executeWithPathRecovery(
        effectiveParams,
        ctx.cwd,
        signal,
        (nextParams) => getTools(ctx.cwd).find.execute(id, nextParams, signal, onUpdate),
      );
      return withContextEfficiencyDetails(result, {
        kind: "find",
        query: params.pattern,
        path: params.path ?? ctx.cwd,
        generic,
      });
    },
    renderCall(args, theme) {
      const location =
        args.path && args.path !== "."
          ? theme.fg("dim", ` in ${args.path}`)
          : "";
      return new Text(
        theme.fg("toolTitle", "› Find ") +
          theme.fg("accent", args.pattern || "…") +
          location,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "  Finding…"), 0, 0);
      const output = textOutput(result);
      if (expanded) return expandedOutput(output, theme);
      if (context.isError)
        return new Text(theme.fg("error", "  ✗ Find failed"), 0, 0);
      const count = countLines(output);
      return new Text(
        theme.fg("dim", `  ✓ ${count} file${count === 1 ? "" : "s"}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: initial.grep.description,
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
    parameters: initial.grep.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      const generic = params.path === undefined && params.glob === undefined;
      const result = await getTools(ctx.cwd).grep.execute(
        id,
        {
          ...params,
          context: Math.min(MAX_GREP_CONTEXT, Math.max(0, params.context ?? 0)),
          limit: Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT),
          ...(generic ? { glob: GREP_EXCLUDE_GLOB } : {}),
        },
        signal,
        onUpdate,
      );
      return withContextEfficiencyDetails(result, {
        kind: "grep",
        query: params.pattern,
        path: params.path ?? ctx.cwd,
        ...(params.glob === undefined ? {} : { glob: params.glob }),
        generic,
      });
    },
    renderCall(args, theme) {
      const location =
        args.path && args.path !== "."
          ? theme.fg("dim", ` in ${args.path}`)
          : "";
      return new Text(
        theme.fg("toolTitle", "› Search ") +
          theme.fg("accent", args.pattern || "…") +
          location,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "  Searching…"), 0, 0);
      const output = textOutput(result);
      if (expanded) return expandedOutput(output, theme);
      if (context.isError)
        return new Text(theme.fg("error", "  ✗ Search failed"), 0, 0);
      const count = countLines(output);
      return new Text(
        theme.fg("dim", `  ✓ ${count} match${count === 1 ? "" : "es"}`),
        0,
        0,
      );
    },
  });

  pi.on("context", (event, ctx) => ({
    messages: transformWorkingContext(event.messages, ctx.cwd),
  }));
}
