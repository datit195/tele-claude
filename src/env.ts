/**
 * Auto-load configuration from ``.env`` at the repo root.
 *
 * This module is imported for its side effect (before any other module
 * that reads ``process.env``). The load order matters because bot.ts
 * and hooks.ts read env vars at top-level initialisation — by the time
 * their constants are evaluated, ``process.env`` must already contain
 * whatever ``.env`` provided.
 *
 * Resolution strategy:
 *   1. ``TELE_CLAUDE_HOME`` env var if set (useful when the repo lives
 *      somewhere other than ~/tele-claude, e.g. systemd units with a
 *      WorkingDirectory override).
 *   2. Otherwise, the directory two levels up from this module. When
 *      run compiled, that's ``dist/..`` → repo root. When run via tsx,
 *      that's ``src/..`` → also repo root.
 *
 * Values already present in ``process.env`` win over the file — this
 * matches dotenv's default behaviour and lets users override via shell
 * without editing the file.
 *
 * Uses Node's built-in ``process.loadEnvFile`` (stable in v20.12+); no
 * extra dependency needed.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  const override = process.env.TELE_CLAUDE_HOME;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

const envFile = join(repoRoot(), ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Silent — malformed .env shouldn't crash the bot on startup.
    // Users can always verify by running `node --env-file=.env -e 0`
    // which surfaces the parse error explicitly.
  }
}
