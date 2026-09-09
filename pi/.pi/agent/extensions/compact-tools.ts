import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const toolsByCwd = new Map<string, ReturnType<typeof createTools>>();

function createTools(cwd: string) {
	return {
		bash: createBashTool(cwd),
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

function expandedOutput(output: string, theme: { fg(color: "toolOutput", text: string): string }): Text {
	if (!output) return new Text("", 0, 0);
	return new Text(`\n${output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n")}`, 0, 0);
}

export default function (pi: ExtensionAPI) {
	const initial = getTools(process.cwd());
	const builtInRead = createReadToolDefinition(process.cwd());

	pi.registerTool({
		name: "read",
		label: "read",
		description: initial.read.description,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
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
			return new Text(
				theme.fg("toolTitle", "› Read ") + theme.fg("accent", args.path || "…") + range,
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) return new Text(theme.fg("dim", "  Reading…"), 0, 0);
			const hasImage = result.content.some((part) => part.type === "image");
			if ((options.expanded || hasImage) && builtInRead.renderResult) {
				return builtInRead.renderResult(result, options, theme, context);
			}
			const output = result.content.find((part) => part.type === "text");
			if (context.isError) return new Text(theme.fg("error", "  ✗ Read failed"), 0, 0);
			const lines = output?.type === "text" && output.text !== "" ? output.text.split("\n").length : 0;
			return new Text(theme.fg("dim", `  ✓ ${lines} line${lines === 1 ? "" : "s"}`), 0, 0);
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
			return getTools(ctx.cwd).ls.execute(id, params, signal, onUpdate);
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
			if (context.isError) return new Text(theme.fg("error", "  ✗ List failed"), 0, 0);
			const count = countLines(output);
			return new Text(theme.fg("dim", `  ✓ ${count} entr${count === 1 ? "y" : "ies"}`), 0, 0);
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
				context.isError ? theme.fg("error", "  ✗ Write failed") : theme.fg("dim", "  ✓ Written"),
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
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
		parameters: initial.bash.parameters,
		renderShell: "self",
		async execute(id, params, signal, onUpdate, ctx) {
			return getTools(ctx.cwd).bash.execute(id, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const command = (args.command || "…").replace(/\s+/g, " ").trim();
			return new Text(
				theme.fg("toolTitle", "› Run ") + theme.fg("muted", truncateToWidth(command, 88, "…")),
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("dim", "  Running…"), 0, 0);
			const output = textOutput(result);
			if (expanded) return expandedOutput(output, theme);
			const lines = countLines(output);
			const suffix = lines > 0 ? ` · ${lines} line${lines === 1 ? "" : "s"}` : "";
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
			return getTools(ctx.cwd).find.execute(id, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const location = args.path && args.path !== "." ? theme.fg("dim", ` in ${args.path}`) : "";
			return new Text(
				theme.fg("toolTitle", "› Find ") + theme.fg("accent", args.pattern || "…") + location,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("dim", "  Finding…"), 0, 0);
			const output = textOutput(result);
			if (expanded) return expandedOutput(output, theme);
			if (context.isError) return new Text(theme.fg("error", "  ✗ Find failed"), 0, 0);
			const count = countLines(output);
			return new Text(theme.fg("dim", `  ✓ ${count} file${count === 1 ? "" : "s"}`), 0, 0);
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
			return getTools(ctx.cwd).grep.execute(id, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const location = args.path && args.path !== "." ? theme.fg("dim", ` in ${args.path}`) : "";
			return new Text(
				theme.fg("toolTitle", "› Search ") + theme.fg("accent", args.pattern || "…") + location,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("dim", "  Searching…"), 0, 0);
			const output = textOutput(result);
			if (expanded) return expandedOutput(output, theme);
			if (context.isError) return new Text(theme.fg("error", "  ✗ Search failed"), 0, 0);
			const count = countLines(output);
			return new Text(theme.fg("dim", `  ✓ ${count} match${count === 1 ? "" : "es"}`), 0, 0);
		},
	});
}
