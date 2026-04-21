/**
 * Thin wrappers over ``tmux`` subprocesses.
 *
 * Shared between bot.ts (interactive commands) and hooks.ts (title
 * updates). All functions are sync-over-spawn — tmux commands are fast
 * and we want a predictable order for things like "load-buffer then
 * paste-buffer then send-keys Enter", which is harder to reason about
 * with Promise chains inside an event handler.
 */

import { execFileSync, spawnSync } from "node:child_process";

import { subscribePane } from "./state.js";

export interface ClaudePane {
  paneId: string;
  cwd: string;
  title: string;
}

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/** Return every tmux pane whose current command matches ``*claude*``.
 *
 * Title comes from tmux's ``pane_title`` attribute — our hooks update
 * it on every prompt / tool call / reply so /panes can show what
 * each pane is actually doing, not just the working directory. */
export function listClaudePanes(): ClaudePane[] {
  const { stdout } = run([
    "list-panes",
    "-a",
    // Tab-separated so paths/titles with spaces stay intact.
    "-F",
    "#{pane_id}\t#{pane_current_path}\t#{pane_title}",
    "-f",
    "#{m:*claude*,#{pane_current_command}}",
  ]);
  const panes: ClaudePane[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const paneId = parts[0] ?? "";
    const cwd = parts[1] ?? "";
    const title = parts[2] ?? "";
    if (paneId) panes.push({ paneId, cwd, title });
  }
  return panes;
}

export function paneExists(paneId: string): boolean {
  const { stdout } = run(["list-panes", "-a", "-F", "#{pane_id}"]);
  return stdout.split(/\s+/).includes(paneId);
}

export function panePath(paneId: string): string {
  const { stdout } = run(["display-message", "-p", "-t", paneId, "#{pane_current_path}"]);
  return stdout.trim();
}

export function capturePane(paneId: string, lines: number): { stdout: string; ok: boolean } {
  const result = spawnSync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`], {
    encoding: "utf8",
  });
  return { stdout: result.stdout ?? "", ok: result.status === 0 };
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  // Busy-wait is fine here — these are short (100–400 ms) and the
  // calling path is a one-shot subprocess. Avoids pulling Atomics
  // helpers into modules that don't otherwise need them.
  while (Date.now() < end) {
    /* spin */
  }
}

/** Send text to a tmux pane, handling the multi-line paste trap.
 *
 * Multi-line text lands in Claude Code's TUI as a collapsed
 * ``[Pasted text #N +M lines]`` token. If we hit Enter too quickly
 * after the paste, the REPL hasn't yet registered the paste as a
 * finished token and the Enter gets swallowed — the prompt stays
 * on screen but never submits. A short pause lets the REPL settle.
 * Also route multi-line via tmux load-buffer / paste-buffer so the
 * REPL treats it as a genuine paste (triggers the collapse path)
 * rather than as rapid-fire keystrokes. */
export function sendToTmux(paneId: string, text: string): void {
  if (text.includes("\n")) {
    execFileSync("tmux", ["load-buffer", "-b", "tele-claude-tmp", "-"], { input: text });
    execFileSync("tmux", ["paste-buffer", "-b", "tele-claude-tmp", "-t", paneId, "-d"]);
    sleepMs(300);
  } else {
    execFileSync("tmux", ["send-keys", "-t", paneId, "-l", text]);
  }
  execFileSync("tmux", ["send-keys", "-t", paneId, "Enter"]);
  // Any successful send-via-bot is an implicit subscribe — the user has
  // clearly opted this pane into the Telegram conversation loop.
  subscribePane(paneId);
}

export function sendKey(paneId: string, key: string): void {
  execFileSync("tmux", ["send-keys", "-t", paneId, key]);
  subscribePane(paneId);
}

/** Set a tmux pane's title so `/panes` (and tmux borders, if enabled)
 * show what Claude is actually doing instead of just the working dir.
 *
 * Silent best-effort: tmux unavailable, pane gone, whitespace-only
 * title, etc. all just fall through without raising. Newlines
 * flattened to spaces (tmux titles are single-line) and capped at
 * 60 chars so they fit status lines without truncation. */
export function setPaneTitle(paneId: string, title: string): void {
  if (!paneId || !title) return;
  const clean = title.replace(/[\n\r]/g, " ").trim().slice(0, 60);
  if (!clean) return;
  try {
    spawnSync("tmux", ["select-pane", "-t", paneId, "-T", clean], { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

export function listSessions(): { all: string[]; attached: string } {
  const all = run(["list-sessions", "-F", "#{session_name}"]);
  const attached = run([
    "list-sessions",
    "-F",
    "#{?session_attached,#{session_name},}",
  ]);
  const attachedName = attached.stdout
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? "";
  return {
    all: all.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0),
    attached: attachedName,
  };
}

export function newWindow(session: string, cwd: string): string {
  const result = execFileSync(
    "tmux",
    ["new-window", "-t", `${session}:`, "-c", cwd, "-P", "-F", "#{pane_id}"],
    { encoding: "utf8" },
  );
  return result.trim();
}
