# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tele-claude is a Telegram bot that forwards messages to Claude Code CLI sessions running in tmux panes. The architecture is simple: a single TypeScript file (`src/index.ts`) that uses `node-telegram-bot-api` to poll Telegram and `tmux send-keys` to inject text into tmux panes.

## Core Architecture

### Message Flow
1. User sends `/panes` → Bot runs `tmux list-panes -f '#{m:*claude*,#{pane_current_command}}'` → Returns list of panes running Claude Code
2. User replies to a pane message → Bot extracts pane ID (e.g. `%21`) from replied-to message → Runs `tmux send-keys -t %21 -l "<text>"` → Sends Enter key

### Key Components

**Pane Detection** (src/index.ts:34-59)
- Uses tmux's `-f` filter to match `*claude*` against `pane_current_command`
- Returns array of objects with `{ paneId, path }` structure
- Uses Node.js `execSync` to execute tmux commands

**Message Sending** (src/index.ts:64-70)
- Uses `-l` (literal) flag to prevent shell metacharacter interpretation
- Sends text followed by Enter in separate commands
- Uses `JSON.stringify()` for proper shell escaping

**Pane ID Extraction** (src/index.ts:76-79)
- Regex pattern: `(?<!\w)%\d+(?!\w)` to extract tmux pane IDs from message text
- Used to identify which pane to send messages to

### Security Model

- Only processes messages from the configured `CLAUDE_TELEGRAM_CHAT_ID`
- Uses tmux's `-l` literal flag to prevent command injection
- No shell expansion or interpretation of user input

## Development Commands

### Install dependencies
```bash
npm install
```

### Build the project
```bash
npm run build
```

### Run the bot (production)
```bash
npm start
```

### Run in development mode (with auto-reload)
```bash
npm run dev
```

### Type checking
```bash
npm run type-check
```

### Linting
```bash
npm run lint
```

## Environment Requirements

Required environment variables (configured via `.env` file):
- `CLAUDE_TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `CLAUDE_TELEGRAM_CHAT_ID` - Numeric chat ID of authorized user

The project uses `dotenv` to load environment variables from a `.env` file. Copy `.env.example` to `.env` and configure your values.

## Integration with Claude Code Hooks

The README documents an optional notification hook (`~/.claude/hooks/telegram-notify.sh`) that can be configured to send Telegram notifications when Claude Code needs attention. This creates a bidirectional flow:
- Claude Code → Notification hook → Telegram (shows pane ID in message)
- User replies → Bot → tmux send-keys → Claude Code

The hook receives JSON on stdin with `notification_type`, `cwd`, and uses `TMUX_PANE` environment variable to include the pane ID in the notification message.
