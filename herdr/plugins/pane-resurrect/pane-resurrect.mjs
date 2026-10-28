#!/usr/bin/env node
// Reruns commands that were running in herdr panes when herdr last stopped.
// Records are written by pane-resurrect.bash; this script restores and prunes them.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const SOCKET = process.env.HERDR_SOCKET_PATH || "";
const STATE_ROOT = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "herdr-pane-resurrect",
);
const DIR = path.join(STATE_ROOT, SOCKET.replaceAll("/", "_"));
const ALIAS_DIR = path.join(DIR, ".moved");
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR;

// Herdr restores these itself through its agent integrations.
const AGENTS = [
  "pi", "omp", "claude", "codex", "copilot", "devin", "droid", "kimi", "opencode",
  "kilo", "hermes", "qodercli", "qwen", "letta", "cursor", "cursor-agent",
  "mastracode", "antigravity-cli", "grok", "gemini", "amp", "aider",
];

function log(message) {
  console.log(`[pane-resurrect] ${message}`);
}

function herdr(...args) {
  const out = execFileSync(HERDR, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim() ? JSON.parse(out) : {};
}

function loadConfig() {
  const config = { ignore: [] };
  if (!CONFIG_DIR) return config;
  try {
    const user = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf8"));
    if (Array.isArray(user.ignore)) config.ignore = user.ignore.map(String);
  } catch {}
  return config;
}

// Record ids are pane ids; ":" is fine in Linux filenames.
function listRecords() {
  try {
    return fs.readdirSync(DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readRecord(id) {
  try {
    const text = fs.readFileSync(path.join(DIR, id), "utf8");
    const newline = text.indexOf("\n");
    if (newline === -1) return null;
    const cwd = text.slice(0, newline);
    const command = text.slice(newline + 1).replace(/\n+$/, "");
    return command.trim() ? { cwd, command } : null;
  } catch {
    return null;
  }
}

function removeRecord(id) {
  fs.rmSync(path.join(DIR, id), { force: true });
  fs.rmSync(path.join(ALIAS_DIR, id), { force: true });
}

// Shells keep the pane id they started with, so moved panes keep writing to
// the old id. Aliases map old ids to the pane's current id.
function resolve(id) {
  const seen = new Set();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    try {
      current = fs.readFileSync(path.join(ALIAS_DIR, current), "utf8").trim() || current;
    } catch {
      break;
    }
  }
  return current;
}

function firstWord(command) {
  const words = command.trim().split(/\s+/);
  // Skip env assignments such as FOO=1.
  const word = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) || "";
  return path.basename(word);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function startup() {
  const config = loadConfig();
  const ignore = new Set([...AGENTS, ...config.ignore]);
  const panes = new Map(herdr("pane", "list").result.panes.map((pane) => [pane.pane_id, pane]));

  for (const id of listRecords()) {
    const record = readRecord(id);
    const paneId = resolve(id);
    const pane = panes.get(paneId);
    removeRecord(id);

    if (!record || !pane) continue;
    if (pane.agent || pane.agent_session) {
      log(`${paneId}: skipped, herdr manages the agent in this pane`);
      continue;
    }
    const name = firstWord(record.command);
    if (ignore.has(name)) {
      log(`${paneId}: skipped ignored command: ${record.command}`);
      continue;
    }

    // Send cd as its own line so the re-recorded command stays unprefixed.
    try {
      if (record.cwd && record.cwd !== (pane.foreground_cwd || pane.cwd)) {
        herdr("pane", "run", paneId, `cd -- ${shellQuote(record.cwd)}`);
      }
      herdr("pane", "run", paneId, record.command);
      log(`${paneId}: restored in ${record.cwd}: ${record.command}`);
    } catch (error) {
      log(`${paneId}: failed to run: ${error.stderr || error.message}`);
    }
  }

  fs.rmSync(ALIAS_DIR, { recursive: true, force: true });
}

function findKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value[key] === "string") return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found) return found;
  }
  return undefined;
}

function onEvent() {
  const event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  const name = process.env.HERDR_PLUGIN_EVENT;

  if (name === "pane.moved") {
    const previous = findKey(event, "previous_pane_id");
    const current = findKey(event.pane || event.data?.pane || event, "pane_id");
    if (previous && current && previous !== current) {
      fs.mkdirSync(ALIAS_DIR, { recursive: true });
      fs.writeFileSync(path.join(ALIAS_DIR, previous), current);
    }
    return;
  }

  // pane.closed / pane.exited: the pane's command must not come back.
  // tab.closed / workspace.closed don't name their panes, so prune anything
  // that no longer maps to a live pane.
  const paneId = name.startsWith("pane.") ? findKey(event, "pane_id") : undefined;
  const live = new Set(herdr("pane", "list").result.panes.map((pane) => pane.pane_id));
  for (const id of listRecords()) {
    const current = resolve(id);
    if (current === paneId || !live.has(current)) removeRecord(id);
  }
}

function showSaved() {
  const panes = new Set(herdr("pane", "list").result.panes.map((pane) => pane.pane_id));
  const rows = listRecords()
    .map((id) => ({ id: resolve(id), record: readRecord(id) }))
    .filter(({ id, record }) => record && panes.has(id))
    .map(({ id, record }) => `${id}  ${record.cwd}  ${record.command}`);
  const message = rows.length ? rows.join("\n") : "No running commands recorded";
  console.log(message);
  try {
    execFileSync(HERDR, ["notification", "show", "Saved pane commands", "--body", message], { stdio: "ignore" });
  } catch {}
}

const mode = process.argv[2];
fs.mkdirSync(DIR, { recursive: true });
try {
  if (mode === "startup") startup();
  else if (mode === "event") onEvent();
  else if (mode === "show") showSaved();
  else throw new Error(`unknown mode: ${mode}`);
} catch (error) {
  console.error(`[pane-resurrect] ${error.stack || error}`);
  process.exitCode = 1;
}
