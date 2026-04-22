#!/usr/bin/env bash
[ "${TELE_CLAUDE:-}" = "1" ] || exit 0
HOME_DIR="${TELE_CLAUDE_HOME:-/home/datnt/datnt/tele-claude}"
exec node "$HOME_DIR/dist/hooks.js" reply
