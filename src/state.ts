/**
 * Persistent runtime state for tele-claude.
 *
 * A small JSON file at ~/.cache/tele-claude/state.json plus a couple of
 * sibling subdirectories for ephemeral per-session data. Writes are
 * atomic (temp + rename) so concurrent readers never see a partial file.
 *
 * Shared between the bot (reads + writes) and the Claude Code hooks
 * (mostly reads, plus per-session progress/fingerprint files owned by
 * the hooks themselves). No locking is needed because the bot owns
 * state.json and hooks only touch their own per-session files.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type StateShape = {
  active_pane?: Record<string, string>;
  subscribed_panes?: string[];
  muted_panes?: string[];
  claude_shortcuts?: Record<string, string>;
};

function cacheRoot(): string {
  const root =
    process.env.TELE_CLAUDE_STATE_DIR || join(homedir(), ".cache", "tele-claude");
  mkdirSync(root, { recursive: true });
  return root;
}

function statePath(): string {
  return join(cacheRoot(), "state.json");
}

function load(): StateShape {
  const path = statePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StateShape;
  } catch {
    return {};
  }
}

function save(state: StateShape): void {
  const path = statePath();
  const parent = dirname(path);
  // Two-step atomic write: write to a sibling, rename over the target.
  // The sibling must live in the same directory so rename is atomic on
  // the same filesystem.
  const tmpDir = mkdtempSync(join(parent, ".state-"));
  const tmpFile = join(tmpDir, "state.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(state, sortKeysReplacer(), 2));
    renameSync(tmpFile, path);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** JSON.stringify replacer that emits object keys in sorted order.
 *
 * Python's ``json.dump(..., sort_keys=True)`` produces deterministic
 * output; we mirror that so diffs on state.json stay stable across
 * writes from either side of the port. */
function sortKeysReplacer() {
  return (_key: string, value: unknown): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      );
      return Object.fromEntries(entries);
    }
    return value;
  };
}

function loadStrList(state: StateShape, key: "subscribed_panes" | "muted_panes"): string[] {
  const value = state[key];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

// ---------- Active pane (per Telegram chat) ----------

export function getActivePane(chatId: number): string | undefined {
  const panes = load().active_pane;
  return panes ? panes[String(chatId)] : undefined;
}

export function setActivePane(chatId: number, paneId: string): void {
  const state = load();
  const panes = { ...(state.active_pane ?? {}) };
  panes[String(chatId)] = paneId;
  state.active_pane = panes;
  save(state);
}

// ---------- Subscribed panes (hooks only fire for these) ----------

export function getSubscribedPanes(): Set<string> {
  return new Set(loadStrList(load(), "subscribed_panes"));
}

export function subscribePane(paneId: string): void {
  const state = load();
  const subs = new Set(loadStrList(state, "subscribed_panes"));
  if (subs.has(paneId)) return;
  subs.add(paneId);
  state.subscribed_panes = [...subs].sort();
  save(state);
}

export function unsubscribePane(paneId: string): void {
  const state = load();
  const subs = new Set(loadStrList(state, "subscribed_panes"));
  if (!subs.has(paneId)) return;
  subs.delete(paneId);
  state.subscribed_panes = [...subs].sort();
  save(state);
}

export function isSubscribed(paneId: string): boolean {
  return getSubscribedPanes().has(paneId);
}

/** Remove dead panes from every pane-keyed state section.
 *
 * Returns {removedSubscribed, removedMuted} for user-facing reporting.
 * ``active_pane`` entries pointing at dead panes are also cleared. */
export function prunePanes(alivePaneIds: Set<string>): {
  removedSubscribed: Set<string>;
  removedMuted: Set<string>;
} {
  const state = load();
  let changed = false;

  const subs = new Set(loadStrList(state, "subscribed_panes"));
  const deadSubs = new Set([...subs].filter((p) => !alivePaneIds.has(p)));
  if (deadSubs.size > 0) {
    for (const dead of deadSubs) subs.delete(dead);
    state.subscribed_panes = [...subs].sort();
    changed = true;
  }

  const muted = new Set(loadStrList(state, "muted_panes"));
  const deadMuted = new Set([...muted].filter((p) => !alivePaneIds.has(p)));
  if (deadMuted.size > 0) {
    for (const dead of deadMuted) muted.delete(dead);
    state.muted_panes = [...muted].sort();
    changed = true;
  }

  const active = state.active_pane;
  if (active) {
    const staleChats = Object.entries(active)
      .filter(([, pane]) => !alivePaneIds.has(pane))
      .map(([chat]) => chat);
    for (const chat of staleChats) delete active[chat];
    if (staleChats.length > 0) {
      state.active_pane = active;
      changed = true;
    }
  }

  if (changed) save(state);
  return { removedSubscribed: deadSubs, removedMuted: deadMuted };
}

// ---------- Muted panes (global across chats) ----------

export function getMutedPanes(): Set<string> {
  return new Set(loadStrList(load(), "muted_panes"));
}

export function mutePane(paneId: string): void {
  const state = load();
  const muted = new Set(loadStrList(state, "muted_panes"));
  muted.add(paneId);
  state.muted_panes = [...muted].sort();
  save(state);
}

export function unmutePane(paneId: string): void {
  const state = load();
  const muted = new Set(loadStrList(state, "muted_panes"));
  muted.delete(paneId);
  state.muted_panes = [...muted].sort();
  save(state);
}

export function isMuted(paneId: string): boolean {
  return getMutedPanes().has(paneId);
}

// ---------- Progress message tracking (per session × chat) ----------

function progressDir(): string {
  const path = join(cacheRoot(), "progress");
  mkdirSync(path, { recursive: true });
  return path;
}

function progressFile(key: string): string {
  const safe = key.replace(/[/:]/g, "_");
  return join(progressDir(), `${safe}.json`);
}

export function setProgressMsgId(key: string, messageId: number): void {
  writeFileSync(progressFile(key), JSON.stringify({ message_id: messageId }));
}

export function getProgressMsgId(key: string): number | undefined {
  const path = progressFile(key);
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { message_id?: number };
    return typeof data.message_id === "number" ? data.message_id : undefined;
  } catch {
    return undefined;
  }
}

export function clearProgress(key: string): void {
  try {
    unlinkSync(progressFile(key));
  } catch {
    /* missing file is fine */
  }
}

// ---------- Claude command shortcuts ----------

export function getClaudeShortcuts(): Record<string, string> {
  const data = load().claude_shortcuts;
  return data && typeof data === "object" ? data : {};
}

export function addClaudeShortcut(name: string, description: string): void {
  const state = load();
  const shortcuts = { ...(state.claude_shortcuts ?? {}) };
  shortcuts[name] = description || "Forward to the active Claude pane";
  state.claude_shortcuts = shortcuts;
  save(state);
}

export function removeClaudeShortcut(name: string): void {
  const state = load();
  if (!state.claude_shortcuts || !(name in state.claude_shortcuts)) return;
  delete state.claude_shortcuts[name];
  save(state);
}

// ---------- Progress heartbeat throttle (PostToolUse hook) ----------

function heartbeatFile(sessionId: string): string {
  const dir = join(cacheRoot(), "heartbeat");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/\//g, "_")}.ts`);
}

/** Return true if enough time has passed since the last heartbeat.
 *
 * Used by PostToolUse to throttle ⏳ updates — Telegram limits edits
 * to ~30/min/chat, and updating after every single tool call would
 * spam both the wire and the user's notification tray. */
export function shouldHeartbeat(sessionId: string, minIntervalSeconds = 5.0): boolean {
  const path = heartbeatFile(sessionId);
  const now = Date.now() / 1000;
  if (existsSync(path)) {
    try {
      const last = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(last) && now - last < minIntervalSeconds) return false;
    } catch {
      /* fall through */
    }
  }
  try {
    writeFileSync(path, now.toFixed(3));
  } catch {
    /* best-effort */
  }
  return true;
}

export function clearHeartbeat(sessionId: string): void {
  try {
    unlinkSync(heartbeatFile(sessionId));
  } catch {
    /* missing file is fine */
  }
}

// ---------- Activity tracking (for idle-notification suppression) ----------

function activityFile(sessionId: string): string {
  const dir = join(cacheRoot(), "activity");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/\//g, "_")}.ts`);
}

export function touchActivity(sessionId: string): void {
  try {
    writeFileSync(activityFile(sessionId), (Date.now() / 1000).toFixed(3));
  } catch {
    /* best-effort */
  }
}

export function secondsSinceActivity(sessionId: string): number | undefined {
  const path = activityFile(sessionId);
  if (!existsSync(path)) return undefined;
  try {
    const last = Number(readFileSync(path, "utf8").trim());
    if (!Number.isFinite(last)) return undefined;
    return Math.max(0, Date.now() / 1000 - last);
  } catch {
    return undefined;
  }
}

// ---------- Dedup fingerprints (per session) ----------

function fingerprintFile(sessionId: string): string {
  const dir = join(cacheRoot(), "fingerprints");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/\//g, "_")}.json`);
}

/** Return true if this content was seen within TTL (caller should skip).
 *
 * Otherwise record the new fingerprint and return false. */
export function checkAndSetFingerprint(
  sessionId: string,
  content: string,
  ttlSeconds = 5.0,
): boolean {
  const digest = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  const now = Date.now() / 1000;
  const path = fingerprintFile(sessionId);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { hash?: string; ts?: number };
      if (data.hash === digest && typeof data.ts === "number" && now - data.ts < ttlSeconds) {
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  try {
    writeFileSync(path, JSON.stringify({ hash: digest, ts: now }));
  } catch {
    /* best-effort */
  }
  return false;
}

export { cacheRoot };
