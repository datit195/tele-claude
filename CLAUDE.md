# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

TypeScript + Node.js (20+) project, ESM, npm-managed. No test suite; no CI.

```bash
npm install               # installs deps and compiles to dist/ (via prepare hook)
npm run dev               # run bot via tsx (no rebuild loop)
npm start                 # run the compiled bot (node dist/bot.js)
npm run build             # tsc → dist/
npm run typecheck         # tsc --noEmit
npm run lint              # eslint src
npm run format            # prettier --write src
echo 'hi' | node dist/format-cli.js   # md → Telegram HTML filter
```

The bot reads `CLAUDE_TELEGRAM_BOT_TOKEN` and `CLAUDE_TELEGRAM_CHAT_ID` (comma-separated allowlist) from the environment. `src/env.ts` is imported for its side effect at the top of `bot.ts` and `hooks.ts`; it calls `process.loadEnvFile()` on `<repoRoot>/.env` if it exists, and silently no-ops otherwise. Shell-level env vars win over `.env`. The repo root is resolved from `TELE_CLAUDE_HOME` first, otherwise from the module's own file location (`dist/../` when compiled, `src/../` under tsx).

After editing `src/*.ts`, run `npm run build` before the hook wrappers can see the change — the wrappers exec `node dist/hooks.js`, not a source file. Forgetting this is the single easiest way to get "it works in dev but not in hooks" confusion.

When iterating on bot behaviour, restart via `systemctl --user restart tele-claude` (the recommended deployment) — tail logs with `journalctl --user -u tele-claude -f`.

## Architecture

Two independent programs that cooperate through a shared on-disk state directory:

1. **`src/bot.ts`** — long-polling Telegram bot (`telegraf`). Single process. Handles inbound messages/commands/photos/callbacks and translates them to `tmux send-keys` against Claude Code panes. Detects Claude panes by matching `*claude*` against `pane_current_command`.
2. **`src/hooks.ts`** — Claude Code hook handlers, invoked one-shot per hook event. Dispatched by `process.argv[2]` (`notify`, `reply`, `progress`, `post_tool_use`, `subagent_stop`, `teammate_idle`, `pump`). The shell wrappers under `~/.claude/hooks/telegram-*.sh` are thin `exec node .../dist/hooks.js <mode>` stubs — all logic lives in TS so we can build inline keyboards, dedup, and chunk-split without curl+jq acrobatics.

Shared modules:

- **`src/state.ts`** — file-based persistence (`~/.cache/tele-claude/state.json` + sibling dirs for per-session ephemerals). Atomic writes via `mkdtempSync` + `renameSync`.
- **`src/format.ts`** — markdown → Telegram HTML converter with the narrow-vs-wide table heuristic. Pure stdlib, no deps.
- **`src/telegram.ts`** — direct HTTP API wrapper with the three-layer fallback chain (used by hooks; bot uses telegraf's client instead). Extracted here so the fallback logic lives in one place.
- **`src/tmux.ts`** — `listClaudePanes`, `paneExists`, `sendToTmux` (with the 300 ms multi-line paste sleep), `setPaneTitle`, `listSessions`, `newWindow`.
- **`src/util.ts`** — `htmlEscape`, `truncate`, `normalisePane`, `shortHome`, `expandHome`.

### Shared state (`src/state.ts`)

Single JSON file at `~/.cache/tele-claude/state.json` plus sibling dirs for ephemeral per-session data (`progress/`, `heartbeat/`, `activity/`, `fingerprints/`). Writes are atomic (tempfile + `renameSync`). **There is no locking** — the invariant is that the bot owns `state.json` keys like `active_pane`, `subscribed_panes`, `muted_panes`, `claude_shortcuts`; hooks only write to per-session files keyed by `sessionId`. Don't break that ownership split: if a hook starts writing `state.json` from many concurrent Claude processes, you'll corrupt it.

Override the root with `TELE_CLAUDE_STATE_DIR`. The on-disk schema matches the previous Python version byte-for-byte (sorted keys, two-space JSON indent) so users can upgrade without losing state.

### Subscription model (critical invariant)

Panes are silent by default. A pane becomes **subscribed** only when the user interacts with it via Telegram (picks it in `/panes`, runs `/use %N`, sends any message/photo/shortcut that targets it, or explicit `/subscribe`). Every hook entry point checks `state.isSubscribed(paneId)` and exits silently otherwise. This prevents freshly-started Claude sessions (with `TELE_CLAUDE=1` set globally via alias) from spamming notifications before the user opts in.

Mute is an independent short-circuit at the top of each hook — it suppresses forwarding without dropping the subscription.

### The ⏳ → 🤖 lifecycle (UserPromptSubmit → Stop)

One Claude turn produces a single Telegram message that evolves in place:

1. `UserPromptSubmit` (mode `progress`) sends an ⏳ placeholder, stores its `message_id` in `progress/<session>:<chat>.json`, and spawns a **detached typing-indicator pumper** (`mainPump`) via `spawn(process.execPath, [__filename, 'pump', …], { detached: true, stdio: 'ignore' }).unref()`. The pumper re-sends `sendChatAction=typing` every 4 s until the progress file disappears or the 45-min cap fires.
2. `PostToolUse` (mode `post_tool_use`) edits the ⏳ with a live tool-count + last-tool + running-subagents + latest-text-block preview. Throttled via `state.shouldHeartbeat` (5 s floor) because Telegram rate-limits edits to ~30/min/chat.
3. `SubagentStop` (mode `subagent_stop`) refreshes the same placeholder with a "✓ subagent done" line so fan-outs don't wait 5 s for the next heartbeat. Shares the heartbeat timestamp file (1.5 s floor) so PostToolUse and SubagentStop don't race.
4. `Stop` (mode `reply`) deletes the placeholder, then sends the final formatted 🤖 reply as a fresh message so the user gets a push notification (edits don't push). Clears the heartbeat throttle.

If the pair gets broken (only `Stop` fires, or the user deleted the placeholder), `editOrResendProgress` detects "message to edit not found" and sends a fresh placeholder, updating the progress file to point at it.

### Transcript reading is race-sensitive

Claude Code's JSONL transcript writer is buffered; `Stop` can fire a few hundred ms before the final text block is flushed. `waitForStableText` polls for two consecutive identical reads (max 1.5 s) to guarantee completeness before forwarding. Don't replace it with a naive single read — you'll ship half-written replies.

When iterating over the transcript, a `role=user` entry only resets per-turn state **if it's a real user prompt** (has a `type=text` block or string content). Entries with `type=tool_result` are part of the current assistant turn and must not reset the accumulator. Both `lastAssistantText` and `summariseInProgress` honour this via `isRealUserPrompt`; any new transcript-reading code must too.

### Formatter (`src/format.ts`)

Markdown → Telegram HTML. Telegram's whitelist is tiny (`<b><i><u><s><code><pre><a><blockquote><tg-spoiler>`) and mobile clients **wrap** `<pre>` rather than horizontally scrolling. The table heuristic is the non-obvious bit:

- Narrow tables (total width ≤ `PRE_MAX_WIDTH`, default 34) → aligned `<pre>` with Unicode `─` separators.
- Wider tables → vertical bullet blocks (`• <b>row1</b>\n  → row2` for 2-col, labeled sub-lines for 3+).

Placeholder-stashing (`\x00C{}\x00`, `\x00I{}\x00`, `\x00T{}\x00`) is how code blocks / inline code / tables survive the `htmlEscape` pass without getting double-escaped or re-matched by later regexes.

### Smart splitting for Telegram's 4096-char limit

`chunkForTelegram` in `src/hooks.ts` walks a **shrinking raw-markdown budget** (2500 → 800 chars, ×0.75 each step) until every chunk's **converted HTML form** fits under the target. Naive character counts on raw markdown undershoot because tags inflate text by 20–50 %. `tokenize` keeps fenced code blocks atomic across splits.

### Telegram API error handling

`sendMessage` in `src/telegram.ts` has three fallback layers because silent failures were previously dropping whole chunks of replies:

1. Initial HTML send.
2. If the failure is "inline keyboard button URL" / "Wrong HTTP URL" → retry without `replyMarkup` (local/container-internal URLs like `http://minio:9000` get rejected; the URL stays in text, just no tappable button). `isButtonSafeUrl` filters these out pre-send.
3. If the failure is an HTML parse error → strip tags and retry as plain text with a ⚠️ prefix.

All non-"message is not modified" errors land in `~/.cache/tele-claude/debug/api-errors.log` with a text preview.

### Shortcut name transcoding

Telegram bot commands are restricted to `[a-z0-9_]{1,32}` — no hyphens. Claude slash commands like `/using-superpowers` are stored canonically (hyphenated) in `state.json`, registered in Telegram's menu with hyphens replaced by underscores (`using_superpowers`), and `canonicaliseShortcut` maps the inbound underscore form back before forwarding to the pane. If you add code that touches shortcut names, preserve this round-trip.

### Multi-line paste handling

`sendToTmux` routes multi-line messages through `tmux load-buffer` + `paste-buffer` (triggers Claude's `[Pasted text +N lines]` collapse) rather than `send-keys -l`. A 300 ms sleep before `Enter` is required; without it the REPL hasn't registered the paste as a finished token and swallows the Enter. The sleep is a short busy-wait rather than `await setTimeout()` because `sendToTmux` runs inside a one-shot hook process where an unflushed async tick can outlive the event loop cleanup. Single-line stays on `send-keys -l` (literal flag prevents shell metachar interpretation). Every successful bot-initiated send auto-subscribes the pane.

### ForceReply flow for argument elicitation

Both `/new` and bare-invoked Claude shortcuts use `ForceReply` to solicit args one-handed (friendly to ☰ Menu tappers). The `ARGS_PROMPT_PREFIX` marker in the prompt text is how `onMessage` detects that an inbound message is replying to an args prompt and dispatches accordingly. Skip tokens (`.`, `-`, `skip`, `go`, `bare`, empty) mean "send the command without args".

### telegraf-specific quirks

- Handlers are registered top-to-bottom; `bot.on("text")` catches everything not already consumed by a `bot.command()`. The slash-passthrough for unknown `/foo` lives inside the text handler, because registering a catch-all command matcher would pre-empt the builtins.
- Callback query dispatch uses the flat `data:` string. Don't rely on message content — old messages may have their text deleted, in which case `ctx.editMessageReplyMarkup(undefined)` still works to drop buttons but `ctx.editMessageText` may fail. We wrap the markup-removal in a try/catch for that reason.
- `ctx.reply(...)` with `reply_parameters: { message_id }` is the v4 equivalent of the old `reply_to_message_id` option.
