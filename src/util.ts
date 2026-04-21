/** Small stdlib-style helpers shared across the bot, hooks, and formatter. */

import { homedir } from "node:os";

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Mirror Python's ``html.escape(s, quote=False)`` — no quote escaping. */
export function htmlEscape(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).trimEnd() + "…";
}

export function normalisePane(raw: string): string {
  return raw.startsWith("%") ? raw : `%${raw.replace(/^%+/, "")}`;
}

export function shortHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, "~") : path;
}

export function expandHome(path: string): string {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

/** Count lines the way Python's ``str.splitlines()`` does.
 *
 * Differs from ``s.split("\n").length`` in two important ways:
 *   1. An empty string counts as 0 lines (not 1).
 *   2. A trailing newline does not add a phantom empty line.
 *
 * We need this for the Edit tool-use renderer where a file content
 * like ``"hello\n"`` should show as 1 line, matching what a user would
 * see in an editor, not 2. */
export function countLines(s: string): number {
  if (!s) return 0;
  const parts = s.replace(/\r\n/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}
