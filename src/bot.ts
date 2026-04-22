#!/usr/bin/env node
/**
 * Telegram bot that forwards messages to Claude Code tmux panes.
 *
 * Features
 *   /panes          — tappable keyboard of Claude Code panes; tap to activate.
 *   /use %N         — set active pane without the picker.
 *   /which          — show the active pane.
 *   /pwd [%N]       — show pane's working directory.
 *   /new [dir]      — spawn a fresh Claude pane in a new tmux window.
 *   /cancel [%N]    — send Ctrl-C to a pane (active if omitted).
 *   /mute %N        — silence Notification + Stop hooks for that pane.
 *   /unmute %N      — re-enable hooks.
 *   /muted          — list muted panes.
 *   /subscribe %N   — explicitly subscribe a pane.
 *   /unsubscribe %N — stop forwarding for a pane.
 *   /subscribed     — list subscribed panes.
 *   /history %N [n] — capture and send the last N lines of a pane.
 *   /shortcut …     — add|rm|list Claude slash-command shortcuts.
 *
 * Callback handlers (from inline keyboards placed by hooks or by /panes):
 *   use:%N          — activate a pane.
 *   ans:%N:1|2|3…   — send a digit to a pane (permission prompt answers).
 *   qr:%N:<text>    — quick-reply text to a pane.
 *   cancel:%N       — send Ctrl-C to a pane.
 *
 * Fallback for plain-text messages: resolve pane from a reply-to `%N`,
 * otherwise the active pane for that chat.
 */

import "./env.js";

import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import { Context, Telegraf } from "telegraf";
import type { Message, Update } from "telegraf/types";

import * as state from "./state.js";
import {
  capturePane,
  listClaudePanes,
  listSessions,
  newWindow,
  panePath,
  paneExists,
  sendKey,
  sendToTmux,
} from "./tmux.js";
import { expandHome, htmlEscape, normalisePane, shortHome } from "./util.js";

const BOT_TOKEN = requireEnv("CLAUDE_TELEGRAM_BOT_TOKEN");
const CHAT_IDS: ReadonlySet<number> = new Set(
  (process.env.CLAUDE_TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => Number(c))
    .filter((n) => Number.isFinite(n)),
);

// Where to stash inbound images so Claude Code can pick them up via file path.
const IMAGE_DIR =
  process.env.TELE_CLAUDE_IMAGE_DIR ||
  join(homedir(), ".cache", "tele-claude", "images");

const PANE_RE = /(?<!\w)%\d+(?!\w)/;

// Prefix used on our "waiting for args" prompt messages. The reply
// handler detects these by checking reply_to_message.text against this
// prefix, then extracts the canonical command name from the rest.
const ARGS_PROMPT_PREFIX = "Args for /";

// Reply text values that mean "send the command without any args".
const SKIP_ARGS_TOKENS = new Set(["", ".", "-", "/", "skip", "go", "bare"]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`Missing required env var: ${name}\n`);
    process.exit(1);
  }
  return value;
}

function authorised(chatId: number): boolean {
  return CHAT_IDS.has(chatId);
}

function resolvePane(chatId: number, message: Message): string | undefined {
  const replyTo = (message as any).reply_to_message as Message | undefined;
  if (replyTo && "text" in replyTo && typeof replyTo.text === "string") {
    const match = replyTo.text.match(PANE_RE);
    if (match) return match[0];
  }
  return state.getActivePane(chatId);
}

function paneArgOrActive(chatId: number, args: string[]): string | undefined {
  const first = args[0];
  if (first) return normalisePane(first);
  return state.getActivePane(chatId);
}

function parseArgs(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .slice(1); // drop the command itself
}

function argsFromCtx(ctx: Context): string[] {
  const msg = ctx.message;
  if (!msg || !("text" in msg) || typeof msg.text !== "string") return [];
  return parseArgs(msg.text);
}

// ---------- Commands ----------

async function cmdPanes(ctx: Context): Promise<void> {
  const msg = ctx.message;
  if (!msg || !authorised(ctx.chat?.id ?? 0)) return;

  const panes = listClaudePanes();
  const aliveIds = new Set(panes.map((p) => p.paneId));
  // Purge any state pointing at panes that no longer exist so the UI
  // never shows stale %IDs (active/subscribed/muted all get cleaned).
  state.prunePanes(aliveIds);

  if (panes.length === 0) {
    await ctx.reply("No Claude Code panes found.");
    return;
  }
  const active = state.getActivePane(ctx.chat!.id);
  const subscribed = state.getSubscribedPanes();
  const muted = state.getMutedPanes();

  const rows = panes.map((p) => {
    let badge: string;
    if (p.paneId === active) badge = "● ";
    else if (muted.has(p.paneId)) badge = "🔕 ";
    else if (subscribed.has(p.paneId)) badge = "🔔 ";
    else badge = "· ";

    // Title set by our hooks wins the button label — it tells the user
    // what the pane is doing. Falls back to working dir for panes
    // whose hooks haven't fired yet.
    const dirBase = basename(p.cwd.replace(/\/+$/, ""));
    const labelBody = p.title && !p.title.startsWith(dirBase) ? p.title : shortHome(p.cwd);
    const label = `${badge}${p.paneId}  ${labelBody}`.slice(0, 60);
    return [{ text: label, callback_data: `use:${p.paneId}` }];
  });

  const subsAlive = [...subscribed].filter((s) => aliveIds.has(s)).length;
  const subsSummary = aliveIds.size > 0 ? `${subsAlive}/${aliveIds.size} subscribed` : "none";
  const headerLines = [
    active ? `Active: ${active}` : "No active pane.",
    `Subscriptions: ${subsSummary} · Tap to select (auto-subscribes):`,
  ];
  await ctx.reply(headerLines.join("\n"), {
    reply_markup: { inline_keyboard: rows },
  });
}

async function cmdUse(ctx: Context): Promise<void> {
  const msg = ctx.message;
  if (!msg || !authorised(ctx.chat?.id ?? 0)) return;
  const args = argsFromCtx(ctx);
  const first = args[0];
  if (!first) {
    const current = state.getActivePane(ctx.chat!.id);
    await ctx.reply(current ? `Active: ${current}` : "No active pane. Use /panes or /use %N");
    return;
  }
  const paneId = normalisePane(first);
  state.setActivePane(ctx.chat!.id, paneId);
  state.subscribePane(paneId); // explicit pick = explicit subscription
  await ctx.reply(`Active pane: ${paneId} 🔔 subscribed`);
}

async function cmdWhich(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const current = state.getActivePane(ctx.chat!.id);
  await ctx.reply(current ? `Active: ${current}` : "No active pane. Use /panes or /use %N");
}

async function spawnNewPane(ctx: Context, msg: Message, cwdArg: string): Promise<void> {
  const cwd = cwdArg ? expandHome(cwdArg) : homedir();
  try {
    const { statSync } = await import("node:fs");
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    await ctx.reply(`Directory not found: <code>${htmlEscape(cwd)}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }

  const { all, attached } = listSessions();
  if (all.length === 0) {
    await ctx.reply("No tmux session found. Start tmux on the host first.");
    return;
  }
  const session = attached || all[0]!;

  let newPane: string;
  try {
    newPane = newWindow(session, cwd);
  } catch (exc) {
    const m = exc instanceof Error ? exc.message : String(exc);
    await ctx.reply(`Failed to create pane: ${m}`);
    return;
  }
  if (!newPane) {
    await ctx.reply("tmux didn't return a pane id.");
    return;
  }

  await new Promise((r) => setTimeout(r, 400));
  // Launch `cc` in the new pane — user's convention for Claude Code.
  const { execFileSync } = await import("node:child_process");
  execFileSync("tmux", ["send-keys", "-t", newPane, "cc", "Enter"]);

  state.subscribePane(newPane);
  state.setActivePane(ctx.chat!.id, newPane);

  const shortCwd = shortHome(cwd);
  await ctx.reply(
    `✅ Spawned <code>${htmlEscape(newPane)}</code> in ` +
      `<code>${htmlEscape(shortCwd)}</code> · session ` +
      `<code>${htmlEscape(session)}</code>\n` +
      `Launched <code>cc</code> · active + subscribed 🔔`,
    { parse_mode: "HTML" },
  );
}

async function cmdNew(ctx: Context): Promise<void> {
  const msg = ctx.message;
  if (!msg || !authorised(ctx.chat?.id ?? 0)) return;
  const args = argsFromCtx(ctx);
  const first = args[0];
  if (first) {
    await spawnNewPane(ctx, msg, first);
    return;
  }
  // Bare /new: reply with a ForceReply prompt. Tapping /new from
  // Telegram's ☰ Menu fires it with no args; silent-spawning in $HOME
  // on a misclick is the wrong default.
  await ctx.reply(
    `${ARGS_PROMPT_PREFIX}new?\n\n` +
      `Reply with a directory (e.g. <code>~/Source/foo</code>) or ` +
      `<code>.</code> to use <code>$HOME</code>.`,
    {
      parse_mode: "HTML",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "dir (or . for $HOME)",
        selective: true,
      },
    },
  );
}

async function cmdPwd(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const paneId = paneArgOrActive(ctx.chat!.id, argsFromCtx(ctx));
  if (!paneId) {
    await ctx.reply("Usage: /pwd [%N] (or set an active pane via /use %N)");
    return;
  }
  if (!paneExists(paneId)) {
    await ctx.reply(`Pane ${paneId} no longer exists.`);
    return;
  }
  const path = panePath(paneId) || "(empty)";
  await ctx.reply(
    `<b>${htmlEscape(paneId)}</b>\n<code>${htmlEscape(path)}</code>`,
    { parse_mode: "HTML" },
  );
}

async function cmdCancel(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const paneId = paneArgOrActive(ctx.chat!.id, argsFromCtx(ctx));
  if (!paneId) {
    await ctx.reply("Usage: /cancel %N (or set an active pane first)");
    return;
  }
  if (!paneExists(paneId)) {
    await ctx.reply(`Pane ${paneId} no longer exists.`);
    return;
  }
  try {
    sendKey(paneId, "C-c");
    await ctx.reply(`🛑 Ctrl-C → ${paneId}`);
  } catch (exc) {
    const m = exc instanceof Error ? exc.message : String(exc);
    await ctx.reply(`Failed: ${m}`);
  }
}

async function cmdMute(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const paneId = paneArgOrActive(ctx.chat!.id, argsFromCtx(ctx));
  if (!paneId) {
    await ctx.reply("Usage: /mute %N");
    return;
  }
  state.mutePane(paneId);
  await ctx.reply(`🔕 Muted ${paneId}`);
}

async function cmdUnmute(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const paneId = paneArgOrActive(ctx.chat!.id, argsFromCtx(ctx));
  if (!paneId) {
    await ctx.reply("Usage: /unmute %N");
    return;
  }
  state.unmutePane(paneId);
  await ctx.reply(`🔔 Unmuted ${paneId}`);
}

async function cmdMuted(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const muted = [...state.getMutedPanes()].sort();
  await ctx.reply(muted.length > 0 ? "Muted: " + muted.join(", ") : "No muted panes.");
}

async function cmdSubscribe(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const paneId = paneArgOrActive(ctx.chat!.id, argsFromCtx(ctx));
  if (!paneId) {
    await ctx.reply("Usage: /subscribe %N");
    return;
  }
  state.subscribePane(paneId);
  await ctx.reply(`🔔 Subscribed ${paneId}`);
}

async function cmdUnsubscribe(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const paneId = paneArgOrActive(ctx.chat!.id, argsFromCtx(ctx));
  if (!paneId) {
    await ctx.reply("Usage: /unsubscribe %N");
    return;
  }
  state.unsubscribePane(paneId);
  await ctx.reply(`🔕 Unsubscribed ${paneId} (hooks will skip it)`);
}

async function cmdSubscribed(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const subs = [...state.getSubscribedPanes()].sort();
  await ctx.reply(subs.length > 0 ? "Subscribed: " + subs.join(", ") : "No subscribed panes.");
}

async function cmdHistory(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const args = argsFromCtx(ctx);
  let paneId: string | undefined;
  let lines = 20;
  for (const arg of args) {
    if (arg.startsWith("%")) paneId = normalisePane(arg);
    else if (/^\d+$/.test(arg)) lines = Math.max(1, Math.min(parseInt(arg, 10), 500));
  }
  if (!paneId) paneId = state.getActivePane(ctx.chat!.id);
  if (!paneId) {
    await ctx.reply("Usage: /history %N [lines]");
    return;
  }
  const { stdout, ok } = capturePane(paneId, lines);
  if (!ok) {
    await ctx.reply(`Failed to capture pane ${paneId}.`);
    return;
  }
  let body = stdout.replace(/\s+$/, "");
  if (!body) {
    await ctx.reply(`Pane ${paneId} is empty.`);
    return;
  }
  if (body.length > 3500) body = "…\n" + body.slice(-3500);
  await ctx.reply(
    `<b>${paneId}</b> · last ${lines} lines\n<pre>${htmlEscape(body)}</pre>`,
    { parse_mode: "HTML" },
  );
}

async function cmdShortcut(ctx: Context): Promise<void> {
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const args = argsFromCtx(ctx);
  if (args.length === 0) {
    await ctx.reply(
      "Usage:\n" +
        "/shortcut add <name> [description]\n" +
        "/shortcut rm <name>\n" +
        "/shortcut list",
    );
    return;
  }
  const sub = args[0]!.toLowerCase();
  if (sub === "list") {
    const shortcuts = state.getClaudeShortcuts();
    if (Object.keys(shortcuts).length === 0) {
      await ctx.reply("No shortcuts yet. Add one with /shortcut add <name>");
      return;
    }
    const out = ["<b>Claude shortcuts:</b>"];
    for (const [name, desc] of Object.entries(shortcuts).sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`• /${htmlEscape(name)} — ${htmlEscape(desc)}`);
    }
    await ctx.reply(out.join("\n"), { parse_mode: "HTML" });
    return;
  }
  if (sub === "add") {
    if (args.length < 2) {
      await ctx.reply("Usage: /shortcut add <name> [description]");
      return;
    }
    const name = args[1]!.replace(/^\/+/, "");
    const desc = args.slice(2).join(" ");
    state.addClaudeShortcut(name, desc);
    await publishMenu(botRef);
    await ctx.reply(`Added shortcut /${name}. Menu refreshed.`);
    return;
  }
  if (sub === "rm") {
    if (args.length < 2) {
      await ctx.reply("Usage: /shortcut rm <name>");
      return;
    }
    const name = args[1]!.replace(/^\/+/, "");
    state.removeClaudeShortcut(name);
    await publishMenu(botRef);
    await ctx.reply(`Removed shortcut /${name}. Menu refreshed.`);
    return;
  }
  await ctx.reply(`Unknown subcommand: ${sub}. Try /shortcut list`);
}

// ---------- Callback buttons ----------

async function onCallback(ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query || !("message" in query) || !query.message) return;
  const message = query.message;
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number" || !authorised(chatId)) return;
  const data = "data" in query ? query.data ?? "" : "";

  if (data.startsWith("use:")) {
    const paneId = data.slice(4);
    state.setActivePane(chatId, paneId);
    await ctx.answerCbQuery(`Active: ${paneId}`);
    try {
      await ctx.editMessageText(
        `Active pane: ${paneId}\n\nSend any message to forward it here.`,
      );
    } catch {
      /* edit may fail if message is a photo or old; ignore */
    }
    return;
  }

  if (data.startsWith("ans:")) {
    const rest = data.slice(4);
    const idx = rest.indexOf(":");
    const paneId = idx >= 0 ? rest.slice(0, idx) : rest;
    const answer = idx >= 0 ? rest.slice(idx + 1) : "";
    if (!paneExists(paneId)) {
      await ctx.answerCbQuery(`${paneId} gone`, { show_alert: true });
      return;
    }
    try {
      sendToTmux(paneId, answer);
      // Alert-style popup so the user gets unambiguous confirmation.
      await ctx.answerCbQuery(`✅ Sent ${answer} → ${paneId}`, { show_alert: true });
      // Drop the buttons so the message visually "commits" to the
      // decision. We deliberately DON'T edit the body — the original
      // message's HTML (plan, question text, preamble) is kept intact
      // for scrollback. Editing the text risks re-parsing failures.
      try {
        await ctx.editMessageReplyMarkup(undefined);
      } catch {
        /* ignore */
      }
    } catch (exc) {
      const m = exc instanceof Error ? exc.message : String(exc);
      await ctx.answerCbQuery(`Failed: ${m}`, { show_alert: true });
    }
    return;
  }

  if (data.startsWith("qr:")) {
    const rest = data.slice(3);
    const idx = rest.indexOf(":");
    const paneId = idx >= 0 ? rest.slice(0, idx) : rest;
    const text = idx >= 0 ? rest.slice(idx + 1) : "";
    if (!paneExists(paneId)) {
      await ctx.answerCbQuery(`${paneId} gone`, { show_alert: true });
      return;
    }
    try {
      sendToTmux(paneId, text);
      await ctx.answerCbQuery(`→ ${paneId}: ${text}`);
    } catch (exc) {
      const m = exc instanceof Error ? exc.message : String(exc);
      await ctx.answerCbQuery(`Failed: ${m}`, { show_alert: true });
    }
    return;
  }

  if (data.startsWith("cancel:")) {
    const paneId = data.slice("cancel:".length);
    if (!paneExists(paneId)) {
      await ctx.answerCbQuery(`${paneId} gone`, { show_alert: true });
      return;
    }
    try {
      sendKey(paneId, "C-c");
      await ctx.answerCbQuery(`🛑 Ctrl-C → ${paneId}`, { show_alert: true });
      try {
        await ctx.editMessageReplyMarkup(undefined);
      } catch {
        /* ignore */
      }
    } catch (exc) {
      const m = exc instanceof Error ? exc.message : String(exc);
      await ctx.answerCbQuery(`Failed: ${m}`, { show_alert: true });
    }
    return;
  }

  await ctx.answerCbQuery();
  // silence unused-variable lint; message is reserved for future handlers
  void message;
}

// ---------- Shortcut forwarding / ForceReply args flow ----------

const BUILTIN_COMMANDS = new Set([
  "panes",
  "use",
  "which",
  "pwd",
  "new",
  "cancel",
  "mute",
  "unmute",
  "muted",
  "subscribe",
  "unsubscribe",
  "subscribed",
  "history",
  "shortcut",
]);

/** Map Telegram's underscore-aliased shortcut back to its hyphenated form. */
function canonicaliseShortcut(incoming: string): string {
  const shortcuts = state.getClaudeShortcuts();
  if (incoming in shortcuts) return incoming;
  for (const stored of Object.keys(shortcuts)) {
    if (stored.replace(/-/g, "_") === incoming) return stored;
  }
  return incoming;
}

async function promptForArgs(ctx: Context, canonical: string): Promise<void> {
  const shortcuts = state.getClaudeShortcuts();
  const description = shortcuts[canonical] ?? "";
  const lines = [`${ARGS_PROMPT_PREFIX}${canonical}?`];
  if (description) lines.push(`<i>${htmlEscape(description)}</i>`);
  lines.push("");
  lines.push("Reply with your args, or send <code>.</code> to forward bare.");
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `args for /${canonical}…`,
      selective: true,
    },
  });
}

async function forwardShortcutToPane(
  ctx: Context,
  message: Message,
  canonical: string,
  args: string,
): Promise<void> {
  const forward = `/${canonical}${args ? ` ${args}` : ""}`;
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  const paneId = resolvePane(chatId, message);
  if (!paneId) {
    await ctx.reply("No active pane. Use /panes to pick one, or reply to a pane message.");
    return;
  }
  if (!paneExists(paneId)) {
    await ctx.reply(`Pane ${paneId} no longer exists. /panes to pick a live one.`);
    return;
  }
  try {
    sendToTmux(paneId, forward);
    await ctx.reply(`→ ${paneId}: <code>${htmlEscape(forward.slice(0, 80))}</code>`, {
      parse_mode: "HTML",
      reply_parameters: { message_id: message.message_id },
    });
  } catch (exc) {
    const m = exc instanceof Error ? exc.message : String(exc);
    await ctx.reply(`Failed to send to pane ${paneId}: ${m}`, {
      reply_parameters: { message_id: message.message_id },
    });
  }
}

async function onSlashPassthrough(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !("text" in message) || typeof message.text !== "string") return;
  if (!authorised(ctx.chat?.id ?? 0)) return;
  const text = message.text.trim();
  if (!text.startsWith("/")) return;

  const spaceIdx = text.indexOf(" ");
  const first = spaceIdx >= 0 ? text.slice(0, spaceIdx) : text;
  const rest = spaceIdx >= 0 ? text.slice(spaceIdx + 1) : "";
  // Strip leading slash and any @bot_username suffix.
  const cmdName = first.slice(1).split("@")[0] ?? "";
  if (BUILTIN_COMMANDS.has(cmdName)) return; // handled by command handlers

  const canonical = canonicaliseShortcut(cmdName);
  const shortcuts = state.getClaudeShortcuts();
  if (canonical in shortcuts && !rest.trim()) {
    await promptForArgs(ctx, canonical);
    return;
  }
  await forwardShortcutToPane(ctx, message, canonical, rest.trim());
}

// ---------- Photos ----------

async function onPhoto(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !authorised(ctx.chat?.id ?? 0)) return;

  let fileId: string | undefined;
  let uniqueId: string | undefined;
  let suffix = "jpg";

  if ("photo" in message && Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1]!;
    fileId = photo.file_id;
    uniqueId = photo.file_unique_id;
  } else if (
    "document" in message &&
    message.document &&
    (message.document.mime_type ?? "").startsWith("image/")
  ) {
    fileId = message.document.file_id;
    uniqueId = message.document.file_unique_id;
    const original = message.document.file_name ?? "";
    if (original.includes(".")) suffix = original.split(".").pop()!.toLowerCase();
  } else {
    return;
  }

  const chatId = ctx.chat!.id;
  const paneId = resolvePane(chatId, message);
  if (!paneId) {
    await ctx.reply("No active pane. Use /panes to pick one, or reply to a pane message.");
    return;
  }
  if (!paneExists(paneId)) {
    await ctx.reply(`Pane ${paneId} no longer exists. /panes to pick a live one.`);
    return;
  }

  mkdirSync(IMAGE_DIR, { recursive: true });
  const outPath = join(IMAGE_DIR, `tg_${message.message_id}_${uniqueId}.${suffix}`);

  const link = await ctx.telegram.getFileLink(fileId!);
  const resp = await fetch(link.toString());
  if (!resp.ok || !resp.body) {
    await ctx.reply(`Failed to download image (HTTP ${resp.status}).`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(outPath));

  const caption = "caption" in message && typeof message.caption === "string"
    ? message.caption.trim()
    : "";
  const text = caption ? `${caption}\n${outPath}` : outPath;

  try {
    sendToTmux(paneId, text);
    await ctx.reply(`🖼 → ${paneId}`, {
      reply_parameters: { message_id: message.message_id },
    });
  } catch (exc) {
    const m = exc instanceof Error ? exc.message : String(exc);
    await ctx.reply(`Failed to send to pane ${paneId}: ${m}`, {
      reply_parameters: { message_id: message.message_id },
    });
  }
}

// ---------- Plain text ----------

async function onMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !("text" in message) || typeof message.text !== "string") return;
  if (!authorised(ctx.chat?.id ?? 0)) return;

  // If this is a reply to one of our "Args for /cmd?" prompts, dispatch.
  const replyTo = (message as any).reply_to_message as Message | undefined;
  if (replyTo && "text" in replyTo && typeof replyTo.text === "string" && replyTo.text.startsWith(ARGS_PROMPT_PREFIX)) {
    const header = replyTo.text.slice(ARGS_PROMPT_PREFIX.length);
    const canonical = header.split("?")[0]?.trim() ?? "";
    if (canonical) {
      const raw = message.text.trim();
      const args = SKIP_ARGS_TOKENS.has(raw.toLowerCase()) ? "" : raw;
      if (canonical === "new") {
        await spawnNewPane(ctx, message, args);
        return;
      }
      await forwardShortcutToPane(ctx, message, canonical, args);
      return;
    }
  }

  const chatId = ctx.chat!.id;
  const paneId = resolvePane(chatId, message);
  if (!paneId) {
    await ctx.reply("No active pane. Use /panes to pick one, or reply to a pane message.");
    return;
  }
  if (!paneExists(paneId)) {
    await ctx.reply(`Pane ${paneId} no longer exists. /panes to pick a live one.`);
    return;
  }
  try {
    sendToTmux(paneId, message.text);
    await ctx.reply(`→ ${paneId}`, {
      reply_parameters: { message_id: message.message_id },
    });
  } catch (exc) {
    const m = exc instanceof Error ? exc.message : String(exc);
    await ctx.reply(`Failed to send to pane ${paneId}: ${m}`);
  }
}

// ---------- Menu publishing ----------

const COMMANDS: Array<{ name: string; description: string; handler: (ctx: Context) => Promise<void> }> = [
  { name: "panes", description: "List Claude Code panes (tap to activate+subscribe)", handler: cmdPanes },
  { name: "use", description: "Set active pane: /use %N", handler: cmdUse },
  { name: "which", description: "Show the active pane", handler: cmdWhich },
  { name: "pwd", description: "Show pane's working directory: /pwd [%N]", handler: cmdPwd },
  { name: "new", description: "Spawn a new Claude pane: /new [dir]", handler: cmdNew },
  { name: "cancel", description: "Send Ctrl-C: /cancel [%N]", handler: cmdCancel },
  { name: "mute", description: "Silence hooks: /mute %N", handler: cmdMute },
  { name: "unmute", description: "Re-enable hooks: /unmute %N", handler: cmdUnmute },
  { name: "muted", description: "List muted panes", handler: cmdMuted },
  { name: "subscribe", description: "Subscribe pane to hooks: /subscribe %N", handler: cmdSubscribe },
  { name: "unsubscribe", description: "Stop hooks for pane: /unsubscribe %N", handler: cmdUnsubscribe },
  { name: "subscribed", description: "List subscribed panes", handler: cmdSubscribed },
  { name: "history", description: "Capture pane output: /history %N [lines]", handler: cmdHistory },
  { name: "shortcut", description: "Manage Claude shortcuts (add/rm/list)", handler: cmdShortcut },
];

/** Publish built-in commands + user-defined Claude shortcuts to Telegram.
 *
 * Telegram restricts command names to [a-z0-9_]{1,32}, so any shortcut
 * containing hyphens (e.g. ``using-superpowers``) is registered with
 * the hyphens replaced by underscores (``using_superpowers``). The
 * passthrough handler translates back to the canonical name before
 * forwarding to the pane. */
async function publishMenu(bot: Telegraf<Context<Update>>): Promise<void> {
  const menu = COMMANDS.map((c) => ({ command: c.name, description: c.description }));
  const alphaRe = /^[a-z0-9_]{1,32}$/;
  for (const [name, desc] of Object.entries(state.getClaudeShortcuts()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const alias = name.replace(/-/g, "_").toLowerCase();
    if (!alphaRe.test(alias)) continue;
    menu.push({
      command: alias,
      description: desc || `→ Claude /${name}`,
    });
  }
  await bot.telegram.setMyCommands(menu);
}

// ---------- Entry ----------

let botRef: Telegraf<Context<Update>>;

async function main(): Promise<void> {
  const bot = new Telegraf(BOT_TOKEN);
  botRef = bot;

  for (const cmd of COMMANDS) {
    bot.command(cmd.name, cmd.handler);
  }

  bot.on("callback_query", onCallback);
  bot.on("photo", onPhoto);
  bot.on("document", onPhoto); // handler filters to image mime-types
  // Slash-passthrough runs on any text starting with '/'; text handler
  // runs for everything else. Telegraf dispatches `message` handlers in
  // registration order, so we register slash-first.
  bot.on("text", async (ctx) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) {
      await onSlashPassthrough(ctx);
      return;
    }
    await onMessage(ctx);
  });

  await publishMenu(bot);
  process.stderr.write("Bot started, polling…\n");

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch();
}

main().catch((err) => {
  process.stderr.write(`tele-claude bot failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
