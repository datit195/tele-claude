#!/usr/bin/env bash
BOT_TOKEN="${CLAUDE_TELEGRAM_BOT_TOKEN:?Missing CLAUDE_TELEGRAM_BOT_TOKEN}"
CHAT_ID="${CLAUDE_TELEGRAM_CHAT_ID:?Missing CLAUDE_TELEGRAM_CHAT_ID}"

INPUT=$(cat)
NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // "unknown"')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

case "$NOTIFICATION_TYPE" in
  permission_prompt)  EMOJI="🔐"; LABEL="Permission needed" ;;
  idle_prompt)        EMOJI="💤"; LABEL="Waiting for input" ;;
  *)                  EMOJI="🔔"; LABEL="Notification" ;;
esac

PROJECT="${CWD:+$(basename "$CWD")}"
PANE_ID="${TMUX_PANE:-}"

TEXT="${EMOJI} <b>${LABEL}</b>"
[ -n "$PROJECT" ] && TEXT="${TEXT}  ·  <code>${PROJECT}</code>"
[ -n "$PANE_ID" ] && TEXT="${TEXT}  ·  <code>${PANE_ID}</code>"

curl -s --connect-timeout 5 --max-time 10 \
  -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=$CHAT_ID" \
  --data-urlencode "parse_mode=HTML" \
  --data-urlencode "text=$TEXT" > /dev/null 2>&1