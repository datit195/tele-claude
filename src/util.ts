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
