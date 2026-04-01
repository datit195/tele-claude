#!/usr/bin/env node

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.CLAUDE_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CLAUDE_TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('Error: CLAUDE_TELEGRAM_BOT_TOKEN environment variable is required');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('Error: CLAUDE_TELEGRAM_CHAT_ID environment variable is required');
  process.exit(1);
}

const chatId = parseInt(CHAT_ID, 10);
if (isNaN(chatId)) {
  console.error('Error: CLAUDE_TELEGRAM_CHAT_ID must be a valid number');
  process.exit(1);
}

interface ClaudePane {
  paneId: string;
  path: string;
}

/**
 * List tmux panes running Claude Code.
 */
function listClaudePanes(): ClaudePane[] {
  try {
    const output = execSync(
      'tmux list-panes -a -F "#{pane_id} #{pane_current_path}" -f "#{m:*claude*,#{pane_current_command}}"',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const panes: ClaudePane[] = [];
    for (const line of output.trim().split('\n')) {
      if (line) {
        const parts = line.split(' ');
        if (parts.length >= 2) {
          panes.push({
            paneId: parts[0],
            path: parts.slice(1).join(' '),
          });
        }
      }
    }
    return panes;
  } catch (error: any) {
    if (error.status === 127 || error.message?.includes('command not found')) {
      throw new Error('tmux is not installed. Please install tmux to use this bot.');
    }
    // No tmux server running (no active sessions)
    if (error.stderr?.includes('No such file or directory') || error.stderr?.includes('no server running')) {
      return [];
    }
    console.error('Error listing tmux panes:', error);
    return [];
  }
}

/**
 * Send text to a tmux pane via send-keys with literal flag.
 */
function sendToTmux(paneId: string, text: string): void {
  execSync(`tmux send-keys -t ${paneId} -l ${JSON.stringify(text)}`, {
    encoding: 'utf-8',
  });
  execSync(`tmux send-keys -t ${paneId} Enter`, { encoding: 'utf-8' });
}

/**
 * Extract tmux pane ID from a message.
 * Searches for %N pattern anywhere in the text.
 */
function extractPaneId(text: string): string | null {
  const match = text.match(/(?<!\w)%\d+(?!\w)/);
  return match ? match[0] : null;
}

/**
 * Handle /panes command.
 */
async function handlePanesCommand(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id !== chatId) {
    return;
  }

  try {
    const claudePanes = listClaudePanes();
    if (claudePanes.length === 0) {
      await bot.sendMessage(msg.chat.id, 'No Claude Code panes found.');
      return;
    }

    for (const pane of claudePanes) {
      const shortPath = pane.path.replace(homedir(), '~');
      await bot.sendMessage(msg.chat.id, `${pane.paneId} ${shortPath}`);
    }
  } catch (error: any) {
    await bot.sendMessage(
      msg.chat.id,
      `Error: ${error.message}\n\nInstall tmux with: brew install tmux`
    );
  }
}

/**
 * Handle incoming messages.
 */
async function handleMessage(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (msg.chat.id !== chatId) {
    return;
  }

  const replyTo = msg.reply_to_message;
  if (!replyTo || !replyTo.text) {
    await bot.sendMessage(
      msg.chat.id,
      'Reply to a message containing a tmux pane ID (e.g. %0).',
      { reply_to_message_id: msg.message_id }
    );
    return;
  }

  const paneId = extractPaneId(replyTo.text);
  if (!paneId) {
    await bot.sendMessage(
      msg.chat.id,
      'Could not find a tmux pane ID (e.g. %0) in the replied message.',
      { reply_to_message_id: msg.message_id }
    );
    return;
  }

  const userText = msg.text;
  if (!userText) {
    return;
  }

  console.log(`Sending to tmux pane ${paneId}: ${userText}`);

  try {
    sendToTmux(paneId, userText);
    await bot.sendMessage(msg.chat.id, `Sent to pane ${paneId}`, {
      reply_to_message_id: msg.message_id,
    });
  } catch (error) {
    console.error(`Failed to send to pane ${paneId}:`, error);
    await bot.sendMessage(msg.chat.id, `Failed to send to pane ${paneId}: ${error}`, {
      reply_to_message_id: msg.message_id,
    });
  }
}

/**
 * Main function to start the bot.
 */
function main(): void {
  const bot = new TelegramBot(BOT_TOKEN!, { polling: true });

  bot.onText(/\/panes/, (msg) => {
    void handlePanesCommand(bot, msg);
  });

  bot.on('message', (msg) => {
    // Skip commands
    if (msg.text?.startsWith('/')) {
      return;
    }
    void handleMessage(bot, msg);
  });

  console.log('Bot started, polling...');
}

main();
