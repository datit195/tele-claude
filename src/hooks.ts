#!/usr/bin/env node
/**
 * Claude Code hook handlers for tele-claude.
 *
 * Dispatched as ``node hooks.js <mode>`` where mode is one of:
 *
 *   notify        — Notification hook. Sends a Telegram message when Claude
 *                   needs attention. For permission_prompt notifications,
 *                   adds inline keyboard buttons [1 Allow] [2 Always] [3 Deny]
 *                   that send the corresponding digit to the pane.
 *   reply         — Stop hook. Reads the last assistant message from the
 *                   transcript JSONL, converts markdown→Telegram HTML,
 *                   dedup-checks against recent identical replies, splits
 *                   long messages at paragraph/fence boundaries, attaches
 *                   inline buttons (URL open + quick replies), and either
 *                   edits an existing ⏳ progress message or sends a new one.
 *   progress      — UserPromptSubmit hook. Sends an ⏳ placeholder message
 *                   containing a preview of the submitted prompt, records
 *                   the message_id, and launches the typing-indicator pumper.
 *   post_tool_use — Heartbeat edit of the ⏳ placeholder with a live tool
 *                   count + running-subagent list + latest-text preview.
 *                   Throttled to 5 s per session (Telegram rate-limits edits).
 *   subagent_stop — Refresh the ⏳ placeholder when a Task-spawned subagent
 *                   finishes. Shares the heartbeat timestamp so it can't
 *                   race against post_tool_use.
 *   teammate_idle — Fresh push for an Agent-Team teammate going idle.
 *   pump          — Typing-indicator pumper subprocess. Re-sends
 *                   sendChatAction every 4 s until the progress file is
 *                   cleared or the 45-min cap fires. Launched by ``progress``.
 *
 * The bash hook scripts in ~/.claude/hooks/telegram-*.sh are thin
 * wrappers that exec this module. All logic lives here so we can build
 * inline keyboards, dedup, and split long messages without curl+jq
 * acrobatics for inline keyboards.
 */

import "./env.js";

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { convert } from "./format.js";
import {
  chatIds,
  deleteMessage,
  editMessage,
  InlineKeyboardMarkup,
  sendChatAction,
  sendMessage,
} from "./telegram.js";
import * as state from "./state.js";
import { setPaneTitle } from "./tmux.js";
import { htmlEscape, truncate } from "./util.js";

// Telegram's hard limit is 4096; leave room for header + HTML margin.
const MAX_MESSAGE_LEN = 4000;

// Markdown → HTML inflates by ~20–50 %. Start with a generous raw budget
// and shrink iteratively until no chunk exceeds the HTML budget.
const RAW_SPLIT_BUDGET = 2500;
const MIN_RAW_SPLIT = 800;

// Idle notifications get suppressed unless this many seconds have passed
// since the session's last real activity (UserPromptSubmit or Stop).
// Claude Code's own idle_prompt fires at 60s (hardcoded upstream; see
// anthropics/claude-code#13922).
const IDLE_SUPPRESS_SECONDS = Number(process.env.TELE_CLAUDE_IDLE_MIN_SECONDS ?? "900");

// Typing-indicator pumper: sendChatAction lasts 5 s per call, so the
// pumper re-sends every TYPING_PUMP_INTERVAL seconds while a turn is
// active. TYPING_PUMP_MAX_SECONDS is an absolute wall-clock ceiling
// (protects against truly-orphaned pumpers), but the pumper also exits
// early as soon as the progress file disappears.
const TYPING_PUMP_INTERVAL_SECONDS = 4;
const TYPING_PUMP_MAX_SECONDS = 2700; // 45 min

// ---------- Shared helpers ----------

interface HookEvent {
  transcript_path?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  notification_type?: string;
  message?: string;
  agent_type?: string;
  agent_id?: string;
  teammate_name?: string;
  last_assistant_message?: string;
}

function stdinJson(): HookEvent {
  try {
    const raw = readFileSync(0, "utf8");
    return JSON.parse(raw) as HookEvent;
  } catch {
    return {};
  }
}

function projectName(cwd: string): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/\/+$/, "");
  return basename(trimmed);
}

function buildHeader(cwd: string, paneId: string, emoji: string): string {
  const parts = [emoji];
  const project = projectName(cwd);
  if (project) parts.push(`<code>${htmlEscape(project)}</code>`);
  if (paneId) parts.push(`<code>${htmlEscape(paneId)}</code>`);
  return parts.join(" · ");
}

function paneFromEnv(): string {
  return process.env.TMUX_PANE ?? "";
}

// ---------- Smart split ----------

const FENCE_RE = /```[a-zA-Z0-9_+-]*\n?[\s\S]*?```/g;

type Token = { kind: "text" | "fence"; text: string };

function tokenize(md: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(md)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: "text", text: md.slice(cursor, match.index) });
    }
    tokens.push({ kind: "fence", text: match[0] });
    cursor = FENCE_RE.lastIndex;
  }
  if (cursor < md.length) tokens.push({ kind: "text", text: md.slice(cursor) });
  return tokens;
}

function splitMarkdown(md: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current) {
      chunks.push(current.trimEnd());
      current = "";
    }
  };
  const appendAtom = (atom: string): void => {
    const sep = current ? "\n\n" : "";
    if (current && current.length + sep.length + atom.length > maxLen) {
      flush();
      current = atom;
    } else {
      current += sep + atom;
    }
  };

  for (const token of tokenize(md)) {
    if (token.kind === "fence") {
      if (token.text.length > maxLen) {
        flush();
        let buf = "";
        for (const line of token.text.split("\n")) {
          const lineWithNl = line + "\n";
          if (buf.length + lineWithNl.length > maxLen) {
            chunks.push(buf.trimEnd());
            buf = "";
          }
          buf += lineWithNl;
        }
        if (buf) chunks.push(buf.trimEnd());
      } else {
        appendAtom(token.text);
      }
    } else {
      for (let para of token.text.split("\n\n")) {
        if (!para.trim()) continue;
        if (para.length > maxLen) {
          flush();
          while (para.length > maxLen) {
            chunks.push(para.slice(0, maxLen));
            para = para.slice(maxLen);
          }
          if (para) current = para;
        } else {
          appendAtom(para);
        }
      }
    }
  }
  flush();
  return chunks;
}

/** Split raw markdown so each chunk's HTML form fits within htmlBudget.
 *
 * Markdown → HTML inflates by 20–50 %, which is tough to predict without
 * doing the conversion. We start with a generous raw budget, convert,
 * and shrink iteratively until no chunk exceeds the HTML budget. */
function chunkForTelegram(rawMd: string, htmlBudget: number): string[] {
  let budget = RAW_SPLIT_BUDGET;
  // Safety cap on iterations in case of pathological input.
  for (let step = 0; step < 10; step++) {
    const chunks = splitMarkdown(rawMd, budget);
    const worst = chunks.reduce((max, c) => Math.max(max, convert(c).length), 0);
    if (worst <= htmlBudget || budget <= MIN_RAW_SPLIT) return chunks;
    budget = Math.max(MIN_RAW_SPLIT, Math.floor(budget * 0.75));
  }
  return splitMarkdown(rawMd, MIN_RAW_SPLIT);
}

// ---------- URL + quick-reply keyboards ----------

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
    return `Open ${tail || parsed.host}`.slice(0, 40);
  } catch {
    return ("Open " + url).slice(0, 40);
  }
}

/** Telegram rejects inline-keyboard URLs that aren't publicly routable.
 *
 * Observed live: http://localhost:4200/api → "Wrong HTTP URL", same for
 * bare Docker service names (minio, redis, db, …). These slip into
 * Claude's output when it explains docker-compose setups. Attaching
 * them as URL buttons kills the whole sendMessage (the parse-mode
 * fallback also inherits the bad markup). Filter here BEFORE building
 * buttons — the URL still appears inline in the text. */
function isButtonSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (!host) return false;
    if (!host.includes(".")) return false;
    if (host === "localhost" || host === "localhost.localdomain") return false;
    if (host.startsWith("127.") || host === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

function urlButtons(text: string, maxButtons = 4): InlineKeyboardMarkup["inline_keyboard"] {
  const seen: string[] = [];
  const matches = text.match(URL_RE) ?? [];
  for (let url of matches) {
    url = url.replace(/[.,;:!?\)\]]+$/, "");
    if (!url || seen.includes(url)) continue;
    if (!isButtonSafeUrl(url)) continue;
    seen.push(url);
    if (seen.length >= maxButtons) break;
  }
  return seen.map((u) => [{ text: `🔗 ${urlLabel(u)}`, url: u }]);
}

/** Quick-reply buttons are currently disabled — just type into the chat
 * to send to the active pane. Return a populated list to re-enable. */
function quickReplyKeyboard(_paneId: string): InlineKeyboardMarkup["inline_keyboard"] {
  return [];
}

// ---------- Transcript reading ----------

interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TranscriptEntry {
  message?: {
    role?: string;
    content?: unknown;
  };
}

function readTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      /* skip malformed */
    }
  }
  return entries;
}

function isRealUserPrompt(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return content.some(
      (b): boolean => typeof b === "object" && b !== null && (b as any).type === "text",
    );
  }
  return false;
}

/** Return all assistant text from the most recent turn.
 *
 * Claude Code writes each content block (thinking / text / tool_use) as
 * its own transcript entry. A single turn spans many such entries.
 * Tool-result entries from Claude's tool calls are stored with role=user
 * but type=tool_result — they are PART of the current assistant turn,
 * not a new user prompt, so we must not reset on them. */
function lastAssistantText(transcriptPath: string): string {
  let texts: string[] = [];
  for (const entry of readTranscript(transcriptPath)) {
    const msg = entry.message ?? {};
    const role = msg.role;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    if (role === "user") {
      if (isRealUserPrompt(msg.content)) texts = [];
      continue;
    }
    if (role !== "assistant") continue;
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as any;
      if (b.type === "text" && typeof b.text === "string" && b.text) texts.push(b.text);
    }
  }
  return texts.join("\n\n");
}

/** Wait for the assistant's final text block to stabilise.
 *
 * Claude Code's transcript writer is buffered — the Stop hook often
 * fires milliseconds before the final text block has been flushed to
 * disk, so a naive read returns partial content. Poll until two reads
 * in a row return the same text (stable), or we hit max_wait. */
async function waitForStableText(
  transcriptPath: string,
  maxWaitSeconds = 1.5,
  pollIntervalSeconds = 0.3,
): Promise<string> {
  let prev = lastAssistantText(transcriptPath);
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(pollIntervalSeconds * 1000);
    const current = lastAssistantText(transcriptPath);
    if (current === prev && current) return current;
    prev = current;
  }
  return prev;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Return [most-recent tool_use, text written just before it].
 *
 * The "preamble" is the assistant's free-form narration between the
 * previous boundary (tool_use or real user prompt) and the current
 * tool_use — exactly what the user would see on-pane just above the
 * permission dialog. Knowing that context is crucial when approving
 * AskUserQuestion or ExitPlanMode from the phone.
 *
 * Tool_result entries don't reset the accumulator because they're part
 * of the same assistant turn. Only a real user prompt clears it. */
function findPendingContext(
  transcriptPath: string,
): { tool: ToolUseBlock | undefined; context: string } {
  let currentTexts: string[] = [];
  let lastTool: ToolUseBlock | undefined;
  let lastContext = "";
  for (const entry of readTranscript(transcriptPath)) {
    const msg = entry.message ?? {};
    const role = msg.role;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    if (role === "user") {
      if (isRealUserPrompt(msg.content)) {
        currentTexts = [];
        lastTool = undefined;
        lastContext = "";
      }
      continue;
    }
    if (role !== "assistant") continue;
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as any;
      if (b.type === "text") {
        const text = typeof b.text === "string" ? b.text : "";
        if (text) currentTexts.push(text);
      } else if (b.type === "tool_use") {
        lastTool = b as ToolUseBlock;
        lastContext = currentTexts.join("\n\n").trim();
        currentTexts = [];
      }
    }
  }
  return { tool: lastTool, context: lastContext };
}

interface ProgressSummary {
  toolCount: number;
  lastTool: string;
  latestText: string | undefined;
  runningSubagents: string[];
}

/** Summarise in-flight tool calls for the heartbeat edit.
 *
 * Counts assistant tool_use blocks since the last real user prompt,
 * captures the most recent text block, and lists any Task calls whose
 * matching tool_result hasn't arrived yet (i.e. subagents currently
 * doing work — without this, Task fan-outs look like dead air on the
 * heartbeat). */
function summariseInProgress(transcriptPath: string): ProgressSummary {
  let toolCount = 0;
  let lastTool = "";
  let latestText: string | undefined;
  let taskDescriptions: Map<string, string> = new Map();
  let completedIds: Set<string> = new Set();

  for (const entry of readTranscript(transcriptPath)) {
    const msg = entry.message ?? {};
    const role = msg.role;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    if (role === "user") {
      if (isRealUserPrompt(msg.content)) {
        toolCount = 0;
        lastTool = "";
        latestText = undefined;
        taskDescriptions = new Map();
        completedIds = new Set();
        continue;
      }
      // tool_result entry — record completed tool_use IDs so matching
      // Task calls drop off "still running".
      for (const block of blocks) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as any;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          completedIds.add(b.tool_use_id);
        }
      }
      continue;
    }
    if (role !== "assistant") continue;
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as any;
      if (b.type === "tool_use") {
        toolCount += 1;
        const name = typeof b.name === "string" ? b.name : "";
        lastTool = name;
        if (name === "Task" && typeof b.id === "string") {
          const input = b.input ?? {};
          const desc = String(
            (input.description as string | undefined) ||
              (input.subagent_type as string | undefined) ||
              "",
          ).trim();
          taskDescriptions.set(b.id, desc);
        }
      } else if (b.type === "text") {
        const text = typeof b.text === "string" ? b.text : "";
        if (text) latestText = text;
      }
    }
  }
  const runningSubagents: string[] = [];
  for (const [tuid, desc] of taskDescriptions) {
    if (!completedIds.has(tuid) && desc) runningSubagents.push(desc);
  }
  return { toolCount, lastTool, latestText, runningSubagents };
}

// ---------- Tool-use rendering ----------

function escForBlock(value: unknown, limit = 400): string {
  let text = String(value);
  if (text.length > limit) text = text.slice(0, limit - 1) + "…";
  return htmlEscape(text);
}

/** Render a tool_use block as a Telegram HTML snippet.
 *
 * Used by the Notification hook to tell the user exactly what Claude
 * wants approval for. Known tools get bespoke renderers; unknowns fall
 * back to a shape hint. */
function describeToolUse(tool: ToolUseBlock): string | undefined {
  const name = String(tool.name ?? "?");
  const input = tool.input ?? {};
  if (typeof input !== "object" || input === null) {
    return `<b>${htmlEscape(name)}</b>`;
  }
  const i = input as Record<string, unknown>;

  if (name === "Bash") {
    const cmd = String(i.command ?? "").trim();
    const desc = String(i.description ?? "").trim();
    if (cmd) {
      let body = `<pre>$ ${escForBlock(cmd, 800)}</pre>`;
      if (desc) body += `\n<i>${escForBlock(desc, 200)}</i>`;
      return body;
    }
    return "<b>Bash</b>";
  }
  if (name === "ExitPlanMode") {
    let plan = String(i.plan ?? "").trim();
    if (!plan) return "📋 <b>Plan approval requested</b>";
    let truncated = false;
    if (plan.length > 3000) {
      plan =
        plan.slice(0, 3000).trimEnd() +
        "\n\n… _(plan truncated at 3000 chars — open pane to see full)_";
      truncated = true;
    }
    const rendered = convert(plan);
    const wrapper =
      rendered.length > 400 ? `<blockquote expandable>${rendered}</blockquote>` : rendered;
    let header = "📋 <b>Plan to execute</b>";
    if (truncated) header += " <i>(truncated)</i>";
    return `${header}\n${wrapper}`;
  }
  if (name === "AskUserQuestion") {
    const questions = i.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      const first = (questions[0] && typeof questions[0] === "object" ? questions[0] : {}) as Record<
        string,
        unknown
      >;
      const qText = String(first.question ?? "").trim();
      const multi = Boolean(first.multiSelect);
      const options = Array.isArray(first.options) ? first.options : [];
      const suffix = multi ? " <i>(select all that apply)</i>" : "";
      const lines: string[] = [];
      lines.push(
        qText
          ? `❓ <b>${escForBlock(qText)}</b>${suffix}`
          : `❓ <b>Question needs an answer</b>${suffix}`,
      );
      options.forEach((opt, idx) => {
        let label: string;
        let desc: string;
        if (typeof opt === "object" && opt !== null) {
          const o = opt as Record<string, unknown>;
          label = String(o.label ?? `Option ${idx + 1}`);
          desc = String(o.description ?? "").trim();
        } else if (typeof opt === "string") {
          label = opt;
          desc = "";
        } else {
          return;
        }
        let line = `<b>${idx + 1}. ${escForBlock(label, 120)}</b>`;
        if (desc) line += `\n    <i>${escForBlock(desc, 200)}</i>`;
        lines.push(line);
      });
      return lines.join("\n\n");
    }
    return "❓ <b>Question needs an answer</b>";
  }
  if (name === "Write") {
    const path = String(i.file_path ?? "?");
    const content = String(i.content ?? "");
    const lineCount = content.split("\n").length - (content ? 0 : 1);
    return `📝 <b>Write</b> <code>${escForBlock(path)}</code> (${lineCount} lines)`;
  }
  if (name === "Edit") {
    const path = String(i.file_path ?? "?");
    const oldLines = String(i.old_string ?? "").split("\n").length;
    const newLines = String(i.new_string ?? "").split("\n").length;
    return `✏️ <b>Edit</b> <code>${escForBlock(path)}</code> (−${oldLines} / +${newLines} lines)`;
  }
  if (name === "Read") {
    const path = String(i.file_path ?? "?");
    return `📖 <b>Read</b> <code>${escForBlock(path)}</code>`;
  }
  if (name === "Glob") {
    const pattern = String(i.pattern ?? "?");
    return `🔍 <b>Glob</b> <code>${escForBlock(pattern)}</code>`;
  }
  if (name === "Grep") {
    const pattern = String(i.pattern ?? "?");
    const path = String(i.path ?? "");
    const suffix = path ? ` in <code>${escForBlock(path)}</code>` : "";
    return `🔍 <b>Grep</b> <code>${escForBlock(pattern)}</code>${suffix}`;
  }
  if (name === "Task") {
    const subagent = String(i.subagent_type ?? "?");
    const desc = String(i.description ?? "").trim();
    let out = `🧑‍💻 <b>Task</b> agent=<code>${escForBlock(subagent)}</code>`;
    if (desc) out += `\n<i>${escForBlock(desc, 200)}</i>`;
    return out;
  }
  if (name === "WebFetch") {
    const url = String(i.url ?? "?");
    return `🌐 <b>WebFetch</b> <code>${escForBlock(url)}</code>`;
  }
  const keys = Object.keys(i).slice(0, 3).join(", ");
  return `🛠 <b>${escForBlock(name)}</b>(${escForBlock(keys, 120)})`;
}

function buildPermissionKeyboard(
  paneId: string,
  tool: ToolUseBlock | undefined,
): InlineKeyboardMarkup | undefined {
  if (!paneId) return undefined;

  if (tool && tool.name === "AskUserQuestion") {
    const input = tool.input ?? {};
    const questions = (input as any).questions;
    if (Array.isArray(questions) && questions[0] && typeof questions[0] === "object") {
      const options = (questions[0] as any).options;
      if (Array.isArray(options) && options.length > 0) {
        const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
        options.slice(0, 8).forEach((opt, idx) => {
          let label = "";
          if (typeof opt === "object" && opt !== null) label = String((opt as any).label ?? "");
          else if (typeof opt === "string") label = opt;
          if (!label) label = `Option ${idx + 1}`;
          if (label.length > 40) label = label.slice(0, 37) + "…";
          rows.push([{ text: `${idx + 1}. ${label}`, callback_data: `ans:${paneId}:${idx + 1}` }]);
        });
        return { inline_keyboard: rows };
      }
    }
  }

  if (tool && tool.name === "ExitPlanMode") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Approve plan", callback_data: `ans:${paneId}:1` },
          { text: "📝 Keep planning", callback_data: `ans:${paneId}:2` },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        { text: "1 · Allow once", callback_data: `ans:${paneId}:1` },
        { text: "2 · Always", callback_data: `ans:${paneId}:2` },
        { text: "3 · Deny", callback_data: `ans:${paneId}:3` },
      ],
    ],
  };
}

// ---------- Mode: reply ----------

async function editOrResendProgress(
  chatId: string,
  sessionId: string,
  msgId: number,
  text: string,
): Promise<void> {
  const { ok, error } = await editMessage(chatId, msgId, text, "HTML");
  if (ok) return;
  // "message to edit not found" → the ⏳ was deleted; resurrect it.
  if (error.includes("message to edit not found")) {
    const newId = await sendMessage({
      chatId,
      text,
      parseMode: "HTML",
      disableNotification: true,
    });
    if (newId !== undefined) state.setProgressMsgId(`${sessionId}:${chatId}`, newId);
  }
  // Other errors (rate-limit, parse) → skip; next heartbeat will retry.
}

async function mainReply(): Promise<void> {
  const data = stdinJson();
  const transcriptRaw = data.transcript_path;
  const sessionId = String(data.session_id ?? "unknown");
  const cwd = String(data.cwd ?? "");
  const paneId = paneFromEnv();

  state.touchActivity(sessionId);

  if (!transcriptRaw) return;
  if (!existsSync(transcriptRaw)) return;

  // Subscription gate — hooks only forward from panes the user has
  // interacted with via the bot.
  if (paneId && !state.isSubscribed(paneId)) return;
  if (paneId && state.isMuted(paneId)) return;

  const rawMd = await waitForStableText(transcriptRaw);
  if (!rawMd) return;

  // First line of the reply as pane title — shows what Claude finished
  // with so users can tell idle panes apart in /panes.
  const firstLine = rawMd.trim().split("\n")[0] ?? "";
  if (firstLine) {
    const cleaned = firstLine
      .replace(/^[#*_\- ]+/, "")
      .trim()
      .replace(/[*`]/g, "")
      .slice(0, 40);
    setPaneTitle(paneId, cleaned ? `🤖 ${cleaned}` : "🤖 done");
  }

  // Dedup: skip if the same body was sent within the TTL.
  if (state.checkAndSetFingerprint(sessionId, rawMd)) return;

  const header = buildHeader(cwd, paneId, "🤖");
  const headerOverhead = header.length + 20;

  const chunksMd = chunkForTelegram(rawMd, MAX_MESSAGE_LEN - headerOverhead);
  const total = chunksMd.length;

  const urlMarkup = urlButtons(rawMd);
  const quickMarkup = quickReplyKeyboard(paneId);
  const lastMarkup: InlineKeyboardMarkup | undefined =
    urlMarkup.length > 0 || quickMarkup.length > 0
      ? { inline_keyboard: [...urlMarkup, ...quickMarkup] }
      : undefined;

  for (const chatId of chatIds()) {
    const progressKey = `${sessionId}:${chatId}`;
    const progressId = state.getProgressMsgId(progressKey);

    // Delete the ⏳ placeholder (if any) so the real reply arrives as
    // a fresh sendMessage — which triggers a push notification.
    if (progressId !== undefined) await deleteMessage(chatId, progressId);

    for (let idx = 0; idx < chunksMd.length; idx++) {
      const pieceMd = chunksMd[idx] ?? "";
      const pieceHtml = convert(pieceMd);
      const prefix = total > 1 ? `(${idx + 1}/${total}) ` : "";
      const body = `${prefix}${header}\n\n${pieceHtml}`;
      const isLast = idx === total - 1;
      const markup = isLast ? lastMarkup : undefined;
      // First chunk pushes the notification (the signal that the turn
      // completed). Subsequent chunks are silent so a multi-part reply
      // only buzzes the phone once.
      const silent = idx > 0;
      await sendMessage({
        chatId,
        text: body,
        parseMode: "HTML",
        replyMarkup: markup,
        disableNotification: silent,
      });
    }

    state.clearProgress(progressKey);
  }

  // Turn done — reset the heartbeat throttle for the next turn.
  state.clearHeartbeat(sessionId);
}

// ---------- Mode: notify ----------

async function mainNotify(): Promise<void> {
  const data = stdinJson();
  const notifType = String(data.notification_type ?? "unknown");
  const msgText = String(data.message ?? "").trim();
  const transcriptRaw = data.transcript_path;
  const sessionId = String(data.session_id ?? "unknown");
  const cwd = String(data.cwd ?? "");
  const paneId = paneFromEnv();

  if (paneId && !state.isSubscribed(paneId)) return;
  if (paneId && state.isMuted(paneId)) return;

  // Suppress idle_prompt if the session has had recent activity.
  if (notifType === "idle_prompt") {
    const since = state.secondsSinceActivity(sessionId);
    if (since !== undefined && since < IDLE_SUPPRESS_SECONDS) return;
  }

  const labels: Record<string, [string, string]> = {
    permission_prompt: ["🔐", "Permission needed"],
    idle_prompt: ["💤", "Waiting for input"],
  };
  const [emoji, label] = labels[notifType] ?? ["🔔", "Notification"];

  const headerParts = [`${emoji} <b>${htmlEscape(label)}</b>`];
  const project = projectName(cwd);
  if (project) headerParts.push(`<code>${htmlEscape(project)}</code>`);
  if (paneId) headerParts.push(`<code>${htmlEscape(paneId)}</code>`);
  const header = headerParts.join("  ·  ");

  let pendingTool: ToolUseBlock | undefined;
  let pendingContext = "";
  if (
    (notifType === "permission_prompt" || notifType === "elicitation_dialog") &&
    transcriptRaw &&
    existsSync(transcriptRaw)
  ) {
    const ctx = findPendingContext(transcriptRaw);
    pendingTool = ctx.tool;
    pendingContext = ctx.context;
  }

  const bodyParts: string[] = [];
  if (msgText) bodyParts.push(htmlEscape(msgText));
  if (pendingContext) {
    let preview = pendingContext;
    if (preview.length > 1200) preview = preview.slice(0, 1200).trimEnd() + "…";
    bodyParts.push(`<blockquote>${htmlEscape(preview)}</blockquote>`);
  }
  if (pendingTool) {
    const detail = describeToolUse(pendingTool);
    if (detail) bodyParts.push(detail);
  }

  const text = bodyParts.length > 0 ? `${header}\n\n${bodyParts.join("\n\n")}` : header;

  let replyMarkup: InlineKeyboardMarkup | undefined;
  if (notifType === "permission_prompt") {
    replyMarkup = buildPermissionKeyboard(paneId, pendingTool);
    const toolName = (pendingTool?.name ?? "") || "permission";
    setPaneTitle(paneId, `🔐 ${toolName}`);
  } else if (notifType === "idle_prompt") {
    setPaneTitle(paneId, "💤 idle");
  }

  for (const chatId of chatIds()) {
    await sendMessage({ chatId, text, parseMode: "HTML", replyMarkup });
  }
}

// ---------- Mode: progress ----------

function spawnTypingPumper(sessionId: string, chatId: string): void {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, "pump", sessionId, chatId], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    /* failing here shouldn't block the progress hook */
  }
}

async function mainProgress(): Promise<void> {
  const data = stdinJson();
  const sessionId = String(data.session_id ?? "unknown");
  const cwd = String(data.cwd ?? "");
  const prompt = String(data.prompt ?? "");
  const paneId = paneFromEnv();

  state.touchActivity(sessionId);

  if (paneId && !state.isSubscribed(paneId)) return;
  if (paneId && state.isMuted(paneId)) return;

  // Surface the prompt in the tmux pane title so the user can see at a
  // glance what each of their panes is working on.
  const previewTitle = prompt.trim().replace(/\n/g, " ").slice(0, 40);
  setPaneTitle(paneId, previewTitle ? `⏳ ${previewTitle}` : "⏳ working");

  const header = buildHeader(cwd, paneId, "⏳");
  let preview = prompt.trim();
  if (preview.length > 160) preview = preview.slice(0, 160).trimEnd() + "…";
  const body = preview ? htmlEscape(preview) : "<i>Claude is working…</i>";
  const text = `${header}\n\n${body}`;

  for (const chatId of chatIds()) {
    // ⏳ placeholders go SILENT — the user just sent the prompt, they
    // don't need a phone buzz confirming that. Only the final 🤖 reply
    // (Stop hook) fires a push notification.
    const msgId = await sendMessage({
      chatId,
      text,
      parseMode: "HTML",
      disableNotification: true,
    });
    if (msgId !== undefined) {
      state.setProgressMsgId(`${sessionId}:${chatId}`, msgId);
      spawnTypingPumper(sessionId, chatId);
    }
  }
}

// ---------- Mode: post_tool_use / subagent_stop ----------

function buildProgressEditText(
  header: string,
  summary: ProgressSummary,
  subagentDone: string | undefined,
): string {
  const { toolCount, lastTool, latestText, runningSubagents } = summary;
  const countWord = toolCount === 1 ? "" : "s";
  let heartbeat = `<i>Working… ${toolCount} tool call${countWord}`;
  if (lastTool) heartbeat += `, last: <code>${htmlEscape(lastTool)}</code>`;
  heartbeat += "</i>";
  const lines: string[] = [heartbeat];
  if (subagentDone) {
    lines.push(`✓ subagent done: <code>${htmlEscape(truncate(subagentDone, 40))}</code>`);
  }
  if (runningSubagents.length > 0) {
    const preview = runningSubagents.slice(0, 5);
    const bullets = preview.map((desc) => `🧑‍💻 ${htmlEscape(truncate(desc, 80))}`);
    const extra =
      runningSubagents.length > 5
        ? `\n<i>…and ${runningSubagents.length - 5} more</i>`
        : "";
    lines.push(bullets.join("\n") + extra);
  }
  if (latestText) {
    let preview = latestText.trim();
    if (preview.length > 600) preview = preview.slice(0, 600).trimEnd() + "…";
    lines.push(`<blockquote expandable>${htmlEscape(preview)}</blockquote>`);
  }
  return `${header}\n\n${lines.join("\n\n")}`;
}

function buildProgressTitle(summary: ProgressSummary): string {
  const bits: string[] = [`⏳ ${summary.toolCount}t`];
  if (summary.lastTool) bits.push(`· ${summary.lastTool}`);
  if (summary.runningSubagents.length > 0) bits.push(`+${summary.runningSubagents.length}a`);
  return bits.join(" ");
}

async function mainPostToolUse(): Promise<void> {
  const data = stdinJson();
  const sessionId = String(data.session_id ?? "unknown");
  const transcriptRaw = data.transcript_path;
  const cwd = String(data.cwd ?? "");
  const paneId = paneFromEnv();

  state.touchActivity(sessionId);

  if (paneId && !state.isSubscribed(paneId)) return;
  if (paneId && state.isMuted(paneId)) return;
  if (!transcriptRaw || !existsSync(transcriptRaw)) return;

  const ids = chatIds();
  const anyPending = ids.some(
    (c) => state.getProgressMsgId(`${sessionId}:${c}`) !== undefined,
  );
  if (!anyPending) return;

  if (!state.shouldHeartbeat(sessionId)) return;

  const summary = summariseInProgress(transcriptRaw);
  setPaneTitle(paneId, buildProgressTitle(summary));

  const header = buildHeader(cwd, paneId, "⏳");
  const text = buildProgressEditText(header, summary, undefined);

  for (const chatId of ids) {
    const msgId = state.getProgressMsgId(`${sessionId}:${chatId}`);
    if (msgId === undefined) continue;
    await editMessage(chatId, msgId, text, "HTML");
  }
}

async function mainSubagentStop(): Promise<void> {
  const data = stdinJson();
  const sessionId = String(data.session_id ?? "unknown");
  const agentType = String(data.agent_type ?? "subagent");
  const transcriptRaw = data.transcript_path;
  const cwd = String(data.cwd ?? "");
  const paneId = paneFromEnv();

  state.touchActivity(sessionId);

  if (paneId && !state.isSubscribed(paneId)) return;
  if (paneId && state.isMuted(paneId)) return;
  if (!transcriptRaw || !existsSync(transcriptRaw)) return;

  const ids = chatIds();
  const anyPending = ids.some(
    (c) => state.getProgressMsgId(`${sessionId}:${c}`) !== undefined,
  );
  if (!anyPending) return;

  // Safety floor shared with PostToolUse (1.5 s) — Telegram rate-limits
  // to ~1 msg/sec/chat and N subagents finishing in a burst would
  // otherwise fire N edits in ~100 ms.
  if (!state.shouldHeartbeat(sessionId, 1.5)) return;

  const summary = summariseInProgress(transcriptRaw);
  setPaneTitle(paneId, buildProgressTitle(summary));

  const header = buildHeader(cwd, paneId, "⏳");
  const text = buildProgressEditText(header, summary, agentType);

  for (const chatId of ids) {
    const msgId = state.getProgressMsgId(`${sessionId}:${chatId}`);
    if (msgId !== undefined) await editOrResendProgress(chatId, sessionId, msgId, text);
  }
}

// ---------- Mode: teammate_idle ----------

async function mainTeammateIdle(): Promise<void> {
  const data = stdinJson();
  const teammateName = String(data.teammate_name ?? "");
  const agentType = String(data.agent_type ?? "");
  const _agentId = String(data.agent_id ?? "");
  const cwd = String(data.cwd ?? "");
  const lastMessage = String(data.last_assistant_message ?? "").trim();
  const paneId = paneFromEnv();

  if (paneId && state.isMuted(paneId)) return;

  const label = teammateName || agentType || "teammate";
  const headerParts = [
    "🧑‍💻 <b>Teammate idle</b>",
    `<code>${htmlEscape(truncate(label, 40))}</code>`,
  ];
  const project = projectName(cwd);
  if (project) headerParts.push(`<code>${htmlEscape(project)}</code>`);
  const header = headerParts.join("  ·  ");

  const lines = [header];
  if (agentType && teammateName && agentType !== teammateName) {
    lines.push(`<i>role: <code>${htmlEscape(agentType)}</code></i>`);
  }
  if (lastMessage) {
    lines.push(`<blockquote expandable>${htmlEscape(truncate(lastMessage, 600))}</blockquote>`);
  }
  const text = lines.join("\n\n");

  for (const chatId of chatIds()) {
    await sendMessage({ chatId, text, parseMode: "HTML" });
  }
}

// ---------- Mode: pump (typing indicator) ----------

async function mainPump(): Promise<void> {
  const sessionId = process.argv[3];
  const chatId = process.argv[4];
  if (!sessionId || !chatId) return;
  const progressKey = `${sessionId}:${chatId}`;
  const deadline = Date.now() + TYPING_PUMP_MAX_SECONDS * 1000;
  while (Date.now() < deadline) {
    if (state.getProgressMsgId(progressKey) === undefined) return;
    try {
      await sendChatAction(chatId, "typing");
    } catch {
      /* ignore; next tick retries */
    }
    await sleep(TYPING_PUMP_INTERVAL_SECONDS * 1000);
  }
}

// ---------- Entry ----------

const HANDLERS: Record<string, () => Promise<void>> = {
  notify: mainNotify,
  reply: mainReply,
  progress: mainProgress,
  post_tool_use: mainPostToolUse,
  subagent_stop: mainSubagentStop,
  teammate_idle: mainTeammateIdle,
  pump: mainPump,
};

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!mode || !(mode in HANDLERS)) {
    process.stderr.write(`usage: tele-claude-hooks <${Object.keys(HANDLERS).join("|")}>\n`);
    process.exit(2);
  }
  try {
    await HANDLERS[mode]!();
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`tele-claude hook ${mode} failed: ${msg}\n`);
    process.exit(0);
  }
}

main();
