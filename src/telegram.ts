/**
 * Direct Telegram Bot API HTTP wrapper used by the hooks.
 *
 * The bot itself uses telegraf's client, but the hooks run as one-shot
 * processes where pulling in the whole SDK would add startup latency
 * for no benefit — they just need sendMessage / editMessageText /
 * deleteMessage / sendChatAction. This module keeps that HTTP layer in
 * one place and adds the three-layer fallback chain that rescues
 * otherwise-lost replies when Telegram rejects our payload:
 *
 *   1. Initial HTML send.
 *   2. "inline keyboard button URL" / "Wrong HTTP URL"  → retry without
 *      reply_markup so the text still lands.
 *   3. HTML parse error → strip tags and retry as plain text with a
 *      ⚠️ prefix so the user sees the content.
 *
 * Non-"message is not modified" errors also get appended to
 * ~/.cache/tele-claude/debug/api-errors.log for later inspection.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const API_BASE = "https://api.telegram.org";
const DEBUG_LOG = join(homedir(), ".cache", "tele-claude", "debug", "api-errors.log");

type FormValue = string | number | boolean | object | unknown[] | null | undefined;

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageParams {
  chatId: string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: InlineKeyboardMarkup;
  disableNotification?: boolean;
}

function token(): string | undefined {
  return process.env.CLAUDE_TELEGRAM_BOT_TOKEN;
}

export function chatIds(): string[] {
  const raw = process.env.CLAUDE_TELEGRAM_CHAT_ID ?? "";
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function logApiError(method: string, textPreview: string, err: string): void {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    const ts = new Date().toISOString().replace(/\..*/, "");
    const preview = textPreview.slice(0, 200).replace(/\n/g, "\\n");
    appendFileSync(
      DEBUG_LOG,
      `${ts} ${method} err=${err} text_preview=${JSON.stringify(preview)}\n`,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Low-level Telegram API call. Body values get form-encoded; objects and
 * arrays get JSON-stringified, mirroring the Python version's urlencode
 * approach. Returns the parsed response (possibly {ok:false, description}).
 */
export async function call(method: string, data: Record<string, FormValue>): Promise<any> {
  const tok = token();
  if (!tok) {
    // Silent exit mimics the Python fail-fast; callers shouldn't invoke
    // without the token set, but if they do we don't want to throw into
    // the hook dispatcher.
    return { ok: false, description: "missing CLAUDE_TELEGRAM_BOT_TOKEN" };
  }
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      body.set(key, JSON.stringify(value));
    } else {
      body.set(key, String(value));
    }
  }
  const url = `${API_BASE}/bot${tok}/${method}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = (await resp.json()) as any;
    if (!parsed || parsed.ok !== true) {
      const errDetail = String(parsed?.description ?? `HTTP ${resp.status}`);
      // "message is not modified" is expected for heartbeat edits when
      // nothing changed since the last tick — it's a no-op, not a bug.
      if (!errDetail.includes("message is not modified")) {
        const textPreview = String(data.text ?? "");
        logApiError(method, textPreview, errDetail);
      }
      return { ok: false, description: errDetail };
    }
    return parsed;
  } catch (exc) {
    const detail = exc instanceof Error ? exc.message : String(exc);
    const textPreview = String(data.text ?? "");
    logApiError(method, textPreview, detail);
    return { ok: false, description: detail };
  }
}

const TAG_RE = /<[^>]+>/g;
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** Best-effort tag strip + entity unescape for the plain-text fallback. */
export function stripHtmlTags(text: string): string {
  let plain = text.replace(TAG_RE, "");
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    plain = plain.split(entity).join(char);
  }
  return plain;
}

/**
 * Send a Telegram message with the three-layer fallback chain.
 *
 * When disableNotification=true the message lands silently — still
 * visible in the chat, but no push/sound/badge. Used for ⏳ placeholders
 * and secondary chunks of a split reply so the user only gets ONE phone
 * buzz per turn (when the actual response arrives).
 */
export async function sendMessage(params: SendMessageParams): Promise<number | undefined> {
  const { chatId, text, parseMode, replyMarkup, disableNotification } = params;
  const payload: Record<string, FormValue> = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    reply_markup: replyMarkup,
    disable_notification: disableNotification ? true : undefined,
  };
  const resp = await call("sendMessage", payload);
  if (resp?.ok) return Number(resp.result.message_id);

  const err = String(resp?.description ?? "");

  // Layer 2: bad button URL → retry without reply_markup. Examples:
  //   http://localhost:4200/api  → "Wrong HTTP URL"
  //   http://minio:9000          → "Wrong HTTP URL"
  if (replyMarkup && (err.includes("inline keyboard button URL") || err.includes("Wrong HTTP URL"))) {
    const retry = await call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      reply_markup: undefined,
      disable_notification: disableNotification ? true : undefined,
    });
    if (retry?.ok) return Number(retry.result.message_id);
  }

  // Layer 3: HTML parse error → strip tags and retry as plain text.
  if (parseMode === "HTML") {
    const fallback = stripHtmlTags(text);
    const retry = await call("sendMessage", {
      chat_id: chatId,
      text: `⚠️ (HTML parse failed, sending as plain)\n\n${fallback}`,
      parse_mode: undefined,
      reply_markup: undefined,
      disable_notification: disableNotification ? true : undefined,
    });
    if (retry?.ok) return Number(retry.result.message_id);
  }

  return undefined;
}

/** Edit a message. Returns {ok, error} — callers inspect error to react
 * to "message to edit not found" specifically. */
export async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  parseMode?: "HTML" | "MarkdownV2",
  replyMarkup?: InlineKeyboardMarkup,
): Promise<{ ok: boolean; error: string }> {
  const resp = await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: parseMode,
    reply_markup: replyMarkup,
  });
  if (resp?.ok) return { ok: true, error: "" };
  return { ok: false, error: String(resp?.description ?? "") };
}

/** Delete a previously-sent message. Used to remove the ⏳ placeholder
 * before sending the real reply — that way the real reply is a fresh
 * send (which pushes a notification) rather than a silent edit. */
export async function deleteMessage(chatId: string, messageId: number): Promise<boolean> {
  const resp = await call("deleteMessage", { chat_id: chatId, message_id: messageId });
  return Boolean(resp?.ok);
}

export async function sendChatAction(chatId: string, action: string): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action });
}
