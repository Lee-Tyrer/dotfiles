/**
 * Replaces core file, search, and shell tools with compact renderers, bounded search output,
 * and a working context that drops stale bulky tool output.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ReadToolDetails,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
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

const GREP_MAX_BYTES = 8 * 1024;
const GREP_DEFAULT_LIMIT = 40;
const FIND_MAX_BYTES = 5 * 1024;
const FIND_DEFAULT_LIMIT = 100;
const STALE_TOOL_MAX_BYTES = 8 * 1024;
const MAX_GREP_CONTEXT = 2;
const PATH_HINT_MAX_ENTRIES = 32;
const STALE_TOOLS = new Set(["bash", "ls", "find", "grep"]);
const EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "generated",
  "cache",
];
const GREP_EXCLUDE_GLOB = `!**/{${EXCLUDED_DIRECTORIES.join(",")}}/**`;

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

interface SearchDetails {
  kind: "grep" | "find";
  query: string;
  path: string;
  /** No path or glob was given, so results may include generated directories. */
  generic: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// On a mistyped path, show the nearest existing directory so the model can pick the right one.
async function withPathHint<T>(path: string | undefined, cwd: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!path || !errorText(error).startsWith("Path not found:")) throw error;
    let parent = resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()));
    while (!(await stat(parent).then((info) => info.isDirectory(), () => false))) parent = dirname(parent);
    const entries = (await readdir(parent, { withFileTypes: true }))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b));
    const shown = entries.slice(0, PATH_HINT_MAX_ENTRIES);
    if (entries.length > shown.length) shown.push(`[… ${entries.length - shown.length} more]`);
    const label = relative(cwd, parent) || ".";
    throw new Error(`${errorText(error)}\n\nNearest existing directory ${label.startsWith("..") ? parent : label}:\n${shown.join("\n")}`);
  }
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
  return resultPath.split("/").some((part) => EXCLUDED_DIRECTORIES.includes(part));
}

interface GrepOutputLine {
  path: string;
  line: number;
  match: boolean;
}

function parseGrepOutputLine(line: string): GrepOutputLine | undefined {
  const parsed = /^(.*)(?::(\d+):|-(\d+)-) /.exec(line);
  if (!parsed) return undefined;
  return { path: parsed[1]!, line: Number(parsed[2] ?? parsed[3]), match: parsed[2] !== undefined };
}

// Overlapping context windows repeat lines; keep each file line once, preferring the match form.
function mergeGrepOutput(text: string): { text: string; matches: GrepOutputLine[] } {
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
    } else if (parsed.match && !parseGrepOutputLine(output[previousPosition]!)?.match) {
      output[previousPosition] = line;
      matches.push(parsed);
    }
  }
  return { text: output.join("\n"), matches };
}

function compactBroadGrep(
  matches: GrepOutputLine[],
  search: SearchDetails,
  matchLimitReached: boolean,
): string {
  const fileCounts = new Map<string, number>();
  for (const match of matches) fileCounts.set(match.path, (fileCounts.get(match.path) ?? 0) + 1);
  const topFiles = [...fileCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  const count = `${matches.length}${matchLimitReached ? "+" : ""}`;
  const files = topFiles.length
    ? `\n\nFiles with most observed matches:\n${topFiles.map(([file, fileMatches]) => `  ${file}  ${fileMatches}`).join("\n")}`
    : "";
  return `Search too broad: ${count} matches across ${fileCounts.size} observed files.${files}\n\nQuery: ${search.query}\nPath: ${search.path}\nFull raw result remains in session history.\nRefine the search by directory, filename/glob, or search term.`;
}

function replaceTextContent(message: ToolResultMessage, text: string): AgentMessage {
  return { ...message, content: [{ type: "text", text }] };
}

function messageText(message: ToolResultMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function bashCommands(messages: AgentMessage[]): Map<string, string> {
  const commands = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall" && part.name === "bash" && typeof part.arguments.command === "string") {
        commands.set(part.id, part.arguments.command);
      }
    }
  }
  return commands;
}

function transformWorkingContext(messages: AgentMessage[]): AgentMessage[] {
  const commands = bashCommands(messages);
  // Trailing tool results are the ones the model is about to read; keep them whole.
  let firstRecent = messages.length;
  while (firstRecent > 0 && messages[firstRecent - 1]?.role === "toolResult") firstRecent--;

  return messages.map((message, index): AgentMessage => {
    if (message.role === "bashExecution") {
      if (index === messages.length - 1 || utf8Bytes(message.output) <= STALE_TOOL_MAX_BYTES) return message;
      return {
        ...message,
        output: `[Older shell output omitted from active context.\nCommand: ${message.command}\nExit code: ${message.exitCode ?? "unknown"}\nFull raw result remains in session history.]`,
        truncated: true,
      };
    }
    if (message.role !== "toolResult") return message;
    const text = messageText(message);
    const details = message.details as { contextEfficiency?: SearchDetails; matchLimitReached?: unknown } | undefined;
    const search = details?.contextEfficiency;

    if (search?.kind === "grep") {
      const merged = mergeGrepOutput(text);
      if (utf8Bytes(merged.text) > GREP_MAX_BYTES) {
        return replaceTextContent(message, compactBroadGrep(merged.matches, search, details?.matchLimitReached !== undefined));
      }
      return merged.text === text ? message : replaceTextContent(message, merged.text);
    }
    if (search?.kind === "find") {
      const filtered = search.generic
        ? text.split("\n").filter((line) => !isExcludedResultPath(line)).join("\n")
        : text;
      if (utf8Bytes(filtered) > FIND_MAX_BYTES) {
        const bounded = truncateCompleteLines(filtered, FIND_MAX_BYTES - 256);
        return replaceTextContent(message, `${bounded}\n\n[Find output limited to 5KB. Refine the path or glob. Full raw result remains in session history.]`);
      }
      return filtered === text ? message : replaceTextContent(message, filtered);
    }
    if (index < firstRecent && STALE_TOOLS.has(message.toolName) && utf8Bytes(text) > STALE_TOOL_MAX_BYTES) {
      const command = commands.get(message.toolCallId);
      return replaceTextContent(
        message,
        `[Older ${message.toolName} result omitted from active context.${command ? `\nCommand: ${command}` : ""}\nStatus: ${message.isError ? "failed" : "succeeded"}\nFull raw result remains in session history. Rerun the command or search if exact output is needed.]`,
      );
    }
    return message;
  });
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

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text?.trim() ?? "";
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").filter((line) => line.trim() !== "").length;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One-line result summary; the full output when expanded. `summary` returns text after ✓/✗. */
function renderSummary(
  result: { content: Array<{ type: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  isError: boolean,
  pending: string,
  summary: (output: string, isError: boolean) => string,
): Text {
  if (options.isPartial) return new Text(theme.fg("dim", `  ${pending}`), 0, 0);
  const output = textOutput(result);
  if (options.expanded) {
    return new Text(output ? `\n${output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n")}` : "", 0, 0);
  }
  const text = summary(output, isError);
  return new Text(isError ? theme.fg("error", `  ✗ ${text}`) : theme.fg("dim", `  ✓ ${text}`), 0, 0);
}

function renderTitle(theme: Theme, title: string, subject: string, detail = ""): Text {
  return new Text(theme.fg("toolTitle", `› ${title} `) + subject + detail, 0, 0);
}

function location(theme: Theme, path: string | undefined): string {
  return path && path !== "." ? theme.fg("dim", ` in ${path}`) : "";
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
      "Use read to examine files.",
      "Use edit for changes to existing files, including multiple replacements within one file. Use sd only for repetitive substitutions across multiple files. Do not use other shell commands or scripts to modify existing files. Use write only for new files or complete rewrites.",
    ],
    parameters: initial.read.parameters,
    renderShell: "self",
    async execute(id, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).read.execute(id, params, signal, onUpdate);
    },
    renderCall(args, theme) {
      const range =
        args.offset !== undefined || args.limit !== undefined
          ? theme.fg("dim", ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"}`)
          : "";
      return renderTitle(theme, "Read", theme.fg("accent", args.path || "…"), range);
    },
    renderResult(result, options, theme, context) {
      const hasImage = result.content.some((part) => part.type === "image");
      if (!options.isPartial && (options.expanded || hasImage) && builtInRead.renderResult) {
        return builtInRead.renderResult(result as AgentToolResult<ReadToolDetails | undefined>, options, theme, context);
      }
      return renderSummary(result, options, theme, context.isError, "Reading…", (output, isError) =>
        isError ? "Read failed" : plural(output === "" ? 0 : output.split("\n").length, "line"));
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
      return withPathHint(params.path, ctx.cwd, () => getTools(ctx.cwd).ls.execute(id, params, signal, onUpdate));
    },
    renderCall(args, theme) {
      return renderTitle(theme, "List", theme.fg("accent", args.path || "."));
    },
    renderResult(result, options, theme, context) {
      return renderSummary(result, options, theme, context.isError, "Listing…", (output, isError) =>
        isError ? "List failed" : plural(countLines(output), "entry", "entries"));
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
      return renderTitle(theme, "Write", theme.fg("accent", args.path || "…"), theme.fg("dim", ` · ${plural(lines, "line")}`));
    },
    renderResult(result, options, theme, context) {
      return renderSummary(result, options, theme, context.isError, "Writing…", (_output, isError) =>
        isError ? "Write failed" : "Written");
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
      return renderTitle(theme, "Run", theme.fg("muted", truncateToWidth(command, 88, "…")));
    },
    renderResult(result, options, theme, context) {
      return renderSummary(result, options, theme, context.isError, "Running…", (output, isError) => {
        const lines = countLines(output);
        return `${isError ? "Failed" : "Done"}${lines > 0 ? ` · ${plural(lines, "line")}` : ""}`;
      });
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
      const effectiveParams = { ...params, limit: Math.max(1, params.limit ?? FIND_DEFAULT_LIMIT) };
      const result = await withPathHint(params.path, ctx.cwd, () =>
        getTools(ctx.cwd).find.execute(id, effectiveParams, signal, onUpdate));
      const contextEfficiency: SearchDetails = {
        kind: "find",
        query: params.pattern,
        path: params.path ?? ctx.cwd,
        generic: params.path === undefined,
      };
      return { ...result, details: { ...result.details, contextEfficiency } };
    },
    renderCall(args, theme) {
      return renderTitle(theme, "Find", theme.fg("accent", args.pattern || "…"), location(theme, args.path));
    },
    renderResult(result, options, theme, context) {
      return renderSummary(result, options, theme, context.isError, "Finding…", (output, isError) =>
        isError ? "Find failed" : plural(countLines(output), "file"));
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
      const contextEfficiency: SearchDetails = {
        kind: "grep",
        query: params.pattern,
        path: params.path ?? ctx.cwd,
        generic,
      };
      return { ...result, details: { ...result.details, contextEfficiency } };
    },
    renderCall(args, theme) {
      return renderTitle(theme, "Search", theme.fg("accent", args.pattern || "…"), location(theme, args.path));
    },
    renderResult(result, options, theme, context) {
      return renderSummary(result, options, theme, context.isError, "Searching…", (output, isError) =>
        isError ? "Search failed" : plural(countLines(output), "match", "matches"));
    },
  });

  pi.on("context", (event) => ({ messages: transformWorkingContext(event.messages) }));
}
