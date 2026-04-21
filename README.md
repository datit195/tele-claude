# tele-claude

A Telegram bot that lets you send messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions running in tmux panes — from your phone.

## How it works

```
You (Telegram)                    Server (tmux)
     |                                |
     |  /panes                        |
     |-----> Bot lists Claude Code    |
     |       panes running in tmux    |
     |                                |
     |  "%21 ~/Source/genbook-api"    |
     |  "%72 ~/Source/pipelines"      |
     |<----- one message per pane     |
     |                                |
     |  (reply to %21 message)        |
     |  "fix the failing test"        |
     |-----> Bot extracts %21,        |
     |       runs tmux send-keys  --->| Claude Code in pane %21
     |                                | receives "fix the failing test"
     |  "Sent to pane %21"            |
     |<----- confirmation             |
```

The bot detects Claude Code panes by matching `*claude*` against `pane_current_command` in tmux.

## Prerequisites

- Node.js 20+
- npm (ships with Node)
- tmux (with Claude Code sessions running in panes)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token

### 2. Get your chat ID

1. Message your bot
2. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id":123456789}` in the response

### 3. Create the `.env` file

Clone the repo and copy the example:

```bash
git clone https://github.com/datit195/tele-claude.git
cd tele-claude
cp .env.example .env
chmod 600 .env
```

Edit `.env` and fill in your bot token and chat ID:

```
CLAUDE_TELEGRAM_BOT_TOKEN=your-bot-token
CLAUDE_TELEGRAM_CHAT_ID=123456789
```

Both the bot and the hook dispatcher load this file automatically on startup — no shell sourcing required. If you prefer shell-level config, any var already set in the environment wins over the `.env` value.

> **Multi-user ACL.** `CLAUDE_TELEGRAM_CHAT_ID` accepts a comma-separated list: `"123,456,789"`. Every listed chat can issue commands and receives forwarded notifications/replies. Anyone not on the list is ignored silently.

### 4. Run the bot

```bash
npm install          # installs deps and compiles to dist/ via the prepare script
npm start            # runs node dist/bot.js
```

During development, skip the build step:

```bash
npm run dev          # runs src/bot.ts via tsx (no rebuild loop)
```

The package exposes three bin scripts (after `npm install`): `tele-claude` (bot), `tele-claude-hooks` (hook dispatcher, invoked by the shell wrappers below), and `tele-claude-format` (markdown → Telegram HTML filter, handy for ad-hoc previews: `echo -e '# hi\n**bold**' | node dist/format-cli.js`).

Run it in a detached tmux session so it survives your terminal closing:

```bash
tmux new -d -s tele-claude 'node ~/tele-claude/dist/bot.js'
tmux attach -t tele-claude   # view logs
```

#### Running as a systemd user service (recommended)

For a bot that survives reboots and auto-restarts on crashes, install it as a user service instead of tmux:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tele-claude.service <<'EOF'
[Unit]
Description=tele-claude Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/tele-claude
ExecStart=/usr/bin/env node %h/tele-claude/dist/bot.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tele-claude.service
loginctl enable-linger "$USER"   # keep the service running after logout
```

Operate it:

```bash
systemctl --user status tele-claude          # health
systemctl --user restart tele-claude         # after code changes
journalctl --user -u tele-claude -f          # tail logs
```

If `node` isn't on the systemd PATH (nvm / asdf / fnm installs can hide it), replace `/usr/bin/env node` with the absolute path (e.g. `/home/you/.nvm/versions/node/v20.17.0/bin/node`). The service reads `.env` itself — no need to pre-source anything.

## Usage

### Commands

| Command | What it does |
|---------|--------------|
| `/panes` | Lists Claude Code panes as tappable buttons. Tapping a button sets the **active pane**. Each button's label shows the pane's current **tmux pane-title** — set automatically by our hooks to reflect live activity (`⏳ 7t · Bash +2a`, `🔐 Edit`, `🤖 Found 3 issues`, `💤 idle`) — so you can tell at a glance which pane is doing what without opening each. Muted panes show a 🔕 badge; the active pane shows ●. |
| `/use %N` | Sets `%N` as the active pane without going through the picker. Accepts `/use 2` too. |
| `/which` | Shows the current active pane. |
| `/pwd [%N]` | Shows the pane's live working directory (`pane_current_path`) as a tap-to-copy code block. Falls back to active pane if omitted. |
| `/new [dir]` | Spawn a fresh Claude pane in a new tmux window (defaults to `$HOME`; accepts `~/foo` or absolute paths). Launches `cc` in that shell (user's alias = `claude --dangerously-skip-permissions`), auto-subscribes the pane, and makes it the active pane — the next message you send goes there without `/use`. |
| `/cancel [%N]` | Sends **Ctrl-C** to a pane (active pane if `%N` omitted). Stops a runaway turn from your phone. |
| `/mute %N` | Stops forwarding `Notification` + `Stop` hook messages for that pane (still subscribed). |
| `/unmute %N` | Resumes forwarding. |
| `/muted` | Lists currently muted panes. |
| `/subscribe %N` | Opts a pane into hook forwarding. Auto-triggered by any bot→pane send. |
| `/unsubscribe %N` | Removes a pane from forwarding. Hooks exit silently for it. |
| `/subscribed` | Lists subscribed panes. |
| `/history %N [lines]` | Captures the last N lines (default 20, max 500) of a pane and sends them as a preformatted block. |
| `/shortcut add <name> [desc]` | Registers a Claude slash-command so it shows up in Telegram's `/` autocomplete. Example: `/shortcut add sdlc Run the SDLC orchestrator`. |
| `/shortcut rm <name>` | Removes a shortcut from the menu. |
| `/shortcut list` | Shows all registered shortcuts. |

State (active pane, subscribed panes, mute list, shortcuts) persists in `~/.cache/tele-claude/state.json`, so bot restarts don't lose your selections. The same directory holds per-session ephemerals under `progress/`, `heartbeat/`, `activity/`, `fingerprints/`, and cached inbound images under `images/`. Override the root by setting `TELE_CLAUDE_STATE_DIR=/path` in your `.env`.

### Subscription model — hooks only forward from panes you've interacted with

Even with `TELE_CLAUDE=1` set globally via the `claude` alias, **new tmux panes stay silent until you opt them in**. This prevents a newly-started Claude session from firing notifications at Telegram before you're ready for it.

A pane becomes **subscribed** the moment you:
- send any text, photo, or slash command to it via Telegram, OR
- tap its button in `/panes`, OR
- run `/use %N` or `/subscribe %N`

Hooks (`Notification`, `Stop`, `UserPromptSubmit`) check the subscription set first; unsubscribed panes exit the hook silently. Pair with `/mute` for temporary silencing that keeps the subscription, or `/unsubscribe` for a harder opt-out. Dead panes are purged from the subscribed set every time you run `/panes`.

Badges in `/panes`:
- `●` active + subscribed
- `🔔` subscribed, not active
- `🔕` subscribed, muted
- `·` alive but not subscribed (tap to opt in)

### Pane titles — live activity labels

Each hook fires a `tmux select-pane -T <title>` with a concise status summary so every pane gets a live, human-readable label:

| Event | Title format | Example |
|-------|--------------|---------|
| `UserPromptSubmit` | `⏳ <prompt preview 40c>` | `⏳ fix the auth race condition` |
| `PostToolUse` | `⏳ Nt · <last_tool>[ +Ka]` | `⏳ 7t · Bash +2a` (7 tools, last=Bash, 2 subagents running) |
| `SubagentStop` | refreshed same as PostToolUse | `⏳ 7t · Task +1a` |
| `Notification: permission_prompt` | `🔐 <ToolName>` | `🔐 Edit` |
| `Notification: idle_prompt` | `💤 idle` | `💤 idle` |
| `Stop` | `🤖 <first line of reply 40c>` | `🤖 Found 3 issues — shipping fix` |

These titles show up automatically in `/panes` button labels on Telegram. For visibility **inside tmux itself** (on pane borders), optionally add to `~/.tmux.conf`:

```tmux
set -g pane-border-status top
set -g pane-border-format " #{pane_id}  #{pane_title} "
```

Reload with `tmux source ~/.tmux.conf` or restart tmux. Not required — Telegram `/panes` shows the titles regardless.

> 💡 **Command menu.** The bot publishes this list to Telegram via `setMyCommands` on startup. Tap the **☰ Menu** button in the chat (or type `/`) to see all commands with descriptions and pick one by tap.

### Sending messages to Claude Code

Three ways — whichever feels most natural:

1. **Active-pane flow** *(recommended for long chats)* — pick a pane once via `/panes` or `/use %N`. Every normal message goes to that pane until you switch.
2. **Reply flow** — reply to any message that contains a pane ID (`%N`): bot confirmations, `/panes` listings, and 🤖 Claude replies all work.
3. **Quick-reply buttons** *(disabled by default; flip `quickReplyKeyboard()` in `src/hooks.ts` to re-enable)* — inline keyboard with `y` / `n` / `continue` / `/clear` / 🛑 ESC buttons under each 🤖 reply. Shipped off because plain typing into the chat turns out to be faster than tapping buttons for most flows.

### Triggering Claude slash commands from your phone

Claude Code's in-session commands (`/sdlc`, `/using-superpowers`, `/brainstorming`, anything from your skill set) can be invoked from Telegram in three complementary ways:

1. **Autocomplete-driven (zero typos, with args)** — in the Telegram chat, tap the text input and type `/`. Your registered shortcuts appear in the suggestion popup **above** the input bar. Tap one → command name is inserted into the input → finish the args → send. Manage the list with `/shortcut add <name> [description]`, `/shortcut rm <name>`, `/shortcut list`.
2. **☰ Menu-tap (one tap, then ForceReply prompts for args)** — tap the ☰ menu button next to the input bar and pick a shortcut. Telegram sends it immediately as a bare command. The bot detects it's a registered shortcut with no args and replies with a <kbd>ForceReply</kbd> prompt: *"Args for /sdlc?"*. Type your args and hit send — bot forwards `/sdlc <your args>` to the active pane. Send `.` (or any of `-`, `go`, `skip`, `bare`, empty) to forward bare.
3. **Direct typing** — send any message that starts with `/`. Anything unknown to the bot is forwarded verbatim. `/sdlc audit --fix` → pane receives exactly that.

**Why both #1 and #2?** Power users prefer autocomplete (fastest), but ☰ Menu is friendlier when typing is hard (driving, walking, small screen). The ForceReply prompt from #2 gives you a structured input field with a hint placeholder — no need to remember the command name a second time.

**Why the hyphen handling is tricky.** Telegram's bot command names are restricted to `[a-z0-9_]{1,32}` — **no hyphens allowed**. For shortcuts like `using-superpowers` the bot registers `using_superpowers` (underscores) in Telegram's menu, and the forwarding handler converts back to the canonical hyphenated form before sending to the pane. This is transparent to you — you see the Claude name in `/shortcut list`, Telegram shows the underscore version in its autocomplete, and the pane receives the hyphenated original.

**Preloaded shortcuts on fresh install.** None by default — run `/shortcut add <name>` for each Claude command you use often. Keep the list lean (5-10 favourites) so the autocomplete stays skimmable.

### Sending images to Claude Code

Attach any photo (or forward one) to the bot chat and it goes straight to the active pane — same resolution rules as text.

- **Photo** (compressed, default when you attach from gallery) and **Document** image (original quality, sent "as file") are both accepted
- Saved under `~/.cache/tele-claude/images/tg_<msg_id>_<file_unique_id>.<ext>` — deterministic, dedup-safe
- Claude Code picks up the absolute path and loads the image via its vision capability
- **With a caption**: the caption is sent first (on its own line), then the path — Claude reads the instruction and the image together: `check this screenshot for errors\n/home/you/.cache/tele-claude/images/tg_123_abc.jpg`
- **Without a caption**: just the path — follow up with text afterwards and Claude remembers the image
- Override destination by setting `TELE_CLAUDE_IMAGE_DIR=/path/to/dir` in your `.env`

> **Albums (multiple photos in one send):** Telegram delivers each as its own message; the bot forwards them one by one in order.

### Permission prompts from your phone

When Claude Code asks for permission, you get a 🔐 message with three buttons:

- **1 · Allow once** — sends `1` to the pane
- **2 · Always** — sends `2`
- **3 · Deny** — sends `3`

No need to type — tap and go. (The digits match Claude Code's default permission UI.)

### Progress indicator

When the bot forwards your prompt to a pane, Claude Code's `UserPromptSubmit` hook immediately replies with an ⏳ placeholder message that includes a preview of what you sent. When Claude finishes its turn, the `Stop` hook **edits that same message** into the formatted response. You get one message per turn that evolves in place — no clutter.

## Optional: Claude Code integration (bidirectional)

The base bot is one-way: Telegram → tmux. Three Claude Code hooks close the loop:

| Hook | Fires when | What it does |
|------|------------|--------------|
| `UserPromptSubmit` | You (or the bot) submit a prompt to Claude | Sends an ⏳ placeholder to Telegram with a preview |
| `PostToolUse` | After every tool call Claude runs | Throttled heartbeat that edits ⏳ with `Working… N tool calls, last: <Tool>` + a preview of the most recent text block. Prevents long agent turns from going radio-silent. |
| `SubagentStop` | A Task-spawned subagent finishes | Immediately refreshes the heartbeat, adds `✓ subagent done: <agent_type>` line, and lets the running-subagents list shrink without waiting for the PostToolUse throttle. |
| `TeammateIdle` | An Agent Team teammate is about to go idle (experimental — requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) | Sends a fresh 🧑‍💻 push notification with the teammate name + role + last message preview, so you know to send them more work. |
| `Stop` | Claude finishes a turn | Edits that placeholder into the full response (or sends new if no placeholder) |
| `Notification` | Claude needs attention (permission, idle) | Sends 🔐 / 💤 to Telegram — permission prompts include Allow/Always/Deny buttons |

All three share an opt-in gate: they exit silently unless `TELE_CLAUDE=1` is set on the Claude process. Aliasing `claude` to set that flag makes forwarding on-by-default; opting out for a single session is `command claude` or `TELE_CLAUDE=0 claude`.

```
Claude in pane %21                        Telegram
       |                                       |
       | (you tap the active pane message)     |
       | <---- "fix the failing test" ---------|  bot → tmux send-keys
       |                                       |
       | UserPromptSubmit ─────── ⏳ placeholder ──────→  ⏳ project · %21
       |                                                   "fix the failing test"
       |                                       |
       | Claude runs tools, reasons, writes…   |
       |                                       |
       | Stop ──────── edits placeholder ───→  🤖 project · %21
       |                                                   "<formatted response>"
       |                                                   [🔗 Open PR #42]
       |                                       |
       | (you type a reply in the chat)        |
       | <------------- "keep going" ----------|  bot → tmux send-keys
       |                                       |
       | Notification (permission) ─── 🔐 ───→  🔐 Permission needed · %21
       |                                                   [1 Allow once] [2 Always] [3 Deny]
       | <------------- "1" -------------------|  callback → tmux send-keys
```

### 1. Reuse the `.env` file

The hook dispatcher auto-loads `.env` from the repo root (the `.env` created in [Setup → step 3](#3-create-the-env-file)) so you don't need to export secrets in every shell — the wrappers just exec Node and the dispatcher handles the rest.

### 2. Make `claude` forward by default

Append to `~/.bashrc` (or `~/.zshrc`):

```bash
# tele-claude: every `claude` forwards to Telegram by default
alias claude='TELE_CLAUDE=1 command claude'
```

Usage:

| Command | Behavior |
|---------|----------|
| `claude` | Forwards notifications + responses to Telegram |
| `command claude` | Runs Claude silently (bypasses the alias) |
| `TELE_CLAUDE=0 claude` | One-off silent override |

> Prefer explicit opt-in? Use `tclaude() { TELE_CLAUDE=1 claude "$@"; }` and invoke `tclaude` on the sessions you want forwarded, plain `claude` for the rest.

### 3. Install the hook wrappers

Hook logic lives in `src/hooks.ts` (compiled to `dist/hooks.js`). The shell hooks are thin wrappers that exec the Node dispatcher — keeps curl/jq complexity out of bash and lets the hooks build inline keyboards, dedup, and split long messages.

Because every hook wrapper is the same except for the mode name, you can generate them in one pass:

```bash
for mode in notify reply progress post-tool-use subagent-stop teammate-idle; do
  arg="${mode//-/_}"
  cat > "$HOME/.claude/hooks/telegram-${mode}.sh" <<EOF
#!/usr/bin/env bash
[ "\${TELE_CLAUDE:-}" = "1" ] || exit 0
HOME_DIR="\${TELE_CLAUDE_HOME:-\$HOME/tele-claude}"
exec node "\$HOME_DIR/dist/hooks.js" ${arg}
EOF
done
chmod +x ~/.claude/hooks/telegram-{notify,reply,progress,post-tool-use,subagent-stop,teammate-idle}.sh
```

The `teammate-idle` wrapper is only useful if you set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and use Claude Code's Agent Teams feature.

> **Where the repo lives.** Each wrapper resolves the repo from `$TELE_CLAUDE_HOME` (fallback `~/tele-claude`) and invokes `dist/hooks.js`. The hook dispatcher then reads `$TELE_CLAUDE_HOME/.env` itself — no shell-source step. Cloned elsewhere? Export `TELE_CLAUDE_HOME=/path/to/repo` in your shell rc.
>
> **Rebuild after changes.** Whenever you edit `src/*.ts`, run `npm run build` to refresh `dist/`. The hook wrappers execute `dist/hooks.js` directly — they don't pass through `tsx` at runtime so there's no source-watching.

### 4. Register the hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/telegram-notify.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/telegram-reply.sh" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/telegram-progress.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/telegram-post-tool-use.sh" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/telegram-subagent-stop.sh" }
        ]
      }
    ],
    "TeammateIdle": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/telegram-teammate-idle.sh" }
        ]
      }
    ]
  }
}
```

### 5. Try it

```bash
source ~/.bashrc       # picks up the claude alias
tmux new -s work       # or attach an existing pane
claude                 # forwarding is on by default
```

From Telegram:

1. `/panes` → tap your pane to activate it
2. Send any message → goes straight to the pane (no reply-to needed)
3. ⏳ placeholder appears immediately with a preview of your prompt
4. When Claude finishes, the placeholder edits in place to the formatted 🤖 response with inline buttons for quick replies and any links in the output
5. Tap `continue`, `y`, `/clear`, or any `🔗 Open …` button to act — or type a new message

### What the reply hook does for you

- **Markdown → Telegram HTML** via `src/format.ts` (headers → bold, `**foo**` → `<b>foo</b>`, fenced blocks → `<pre><code>`). **Tables adapt to width**: narrow tables (≤ 34 chars total) render as aligned `<pre>` monospace blocks with Unicode separators; wider tables flatten to vertical bullet blocks (`• <b>label</b>\n  → value` for 2-col, labeled sub-lines for 3+) because Telegram mobile wraps `<pre>` instead of scrolling horizontally. Tune via `PRE_MAX_WIDTH` in the formatter
- **HTML-aware smart split** — markdown is chunked, each chunk is converted to HTML, and the raw-markdown budget shrinks iteratively (2500 → 800 chars) until every chunk's HTML form fits under Telegram's 4096-char limit. Prevents silent 400s from tag-inflated messages
- **Race-safe transcript read** — Claude Code's JSONL writer is buffered, so the Stop hook can fire a few hundred ms before the final text block is flushed to disk. The hook polls the transcript until two consecutive reads return the same text (max 1.5 s), guaranteeing it sees the complete turn
- **Typing indicator while Claude works** — the UserPromptSubmit hook detaches a pumper subprocess that re-sends `sendChatAction=typing` every 4 s so Telegram shows a live "is typing…" status in the chat header. The pumper exits automatically the instant the Stop hook clears the progress file (≤ 4 s lag) or after a hard 10-min cap if Stop never fires
- **Idle-prompt throttling** — Claude Code's `idle_prompt` fires on a hardcoded 60 s timer ([feature request](https://github.com/anthropics/claude-code/issues/13922) for configurability still open). The notify hook suppresses it unless the session has been genuinely silent for `$TELE_CLAUDE_IDLE_MIN_SECONDS` (default **900 s / 15 min**). Both `UserPromptSubmit` and `Stop` hooks count as activity. Override per install by adding e.g. `TELE_CLAUDE_IDLE_MIN_SECONDS=600` to your `.env`
- **Dedup** — identical bodies sent within 5 s for the same session are skipped (silences re-fires)
- **Mute aware** — panes muted via `/mute %N` get no reply hook at all
- **URL extraction** — up to 4 `http(s)://` links in the reply become `🔗 Open <last-path-segment>` buttons under the message
- **Quick-reply keyboard** *(disabled by default)* — `y` / `n` / `continue` / `/clear` / 🛑 ESC buttons; `src/hooks.ts:quickReplyKeyboard` returns `[]` — flip back to a populated list to re-enable

### Caveats

- **Per-session ⏳/🤖 editing** requires the UserPromptSubmit + Stop pair — if only Stop fires, you get a new message instead of an edit. Harmless but noisier.
- **Text blocks only** — tool calls and tool results are not forwarded (keeps noise down).
- **`TELE_CLAUDE` is session-scoped** — subagents and background jobs spawned from that session inherit it.
- **Shell aliases only apply to interactive shells** — scripts that call `claude` non-interactively bypass the alias and run silently. That's usually what you want.
- **Progress/dedup state lives in `~/.cache/tele-claude/`** — delete that directory to reset everything.

## Security notes

- Only chats listed in `CLAUDE_TELEGRAM_CHAT_ID` (comma-separated) are processed; everyone else is ignored silently
- Text is sent to tmux using the `-l` (literal) flag to prevent shell metacharacter interpretation
- The bot uses long polling (no webhook/exposed server needed)
- Callback data on inline buttons includes the `%PANE` it targets — the bot validates the pane still exists before acting
- Credentials live in the repo's `.env` (chmod 600) and a single state file at `~/.cache/tele-claude/state.json`

## Future work: forum-mode topics (one thread per pane)

Currently all panes share a single Telegram chat. Responses and notifications from different panes interleave, and you rely on the `%PANE` tag in the header to know what's what. Telegram's **forum mode** (supergroups with "Topics" enabled) would give each pane its own thread — visually clean separation of concurrent work, especially when running 3+ Claude sessions in parallel.

### Design sketch

1. **Migrate the chat** from private 1:1 to a supergroup with topics enabled (via Bot API `createForumTopic`)
2. **Map pane_id → topic_id** — stored in `state.json` under a new `topics` key. Created lazily: first time a pane fires a hook, the bot creates a topic named `project · %21` and caches the ID
3. **All send calls acquire `message_thread_id`** — both the bot's command replies and the hooks' `sendMessage`. Bot helpers get a `pane_to_thread(pane_id)` accessor
4. **Active pane becomes less central** — the topic you're viewing *is* the active pane. The active-pane state and `/use` command would still work as a fallback for the root chat
5. **Topic lifecycle** — when a pane dies, optionally `closeForumTopic` or rename it to `🪦 %21 (closed)`. Garbage-collect in a periodic job or on `/panes` refresh

### Open questions

- **Migration cost** — moving from private chat to supergroup loses message history. Either run both in parallel during transition or accept the reset
- **Rate limits** — creating many topics in a burst (20+ panes at once) may hit Telegram's `createForumTopic` rate limit. Throttle + exponential backoff needed
- **Permissions** — topics in supergroups need the bot added as admin with `can_manage_topics` permission. Document this in setup
- **Fallback when topics disabled** — gracefully degrade to single-thread mode if the chat isn't a forum (detect via `getChat`)
- **Per-topic ACL** — `CLAUDE_TELEGRAM_CHAT_ID` stays the allowlist; topic_id is only a destination, not a gate

### Blocked on

- Stabilizing the commands + hooks from this PR (currently implemented features) in real use for a week or two. Forum mode is a restructuring that's hard to reverse; better to confirm current UX is solid first
- Deciding on migration strategy (fresh supergroup vs. convert private chat vs. parallel running)

No implementation yet — this section is the design anchor.
