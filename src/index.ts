#!/usr/bin/env node

import 'dotenv/config';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';

const BOT_TOKEN = process.env.CLAUDE_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CLAUDE_TELEGRAM_CHAT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

interface WatcherState {
  paneId: string;
  lastContent: string;
  lastUpdate: number;
  messageId: number;
  intervalId: NodeJS.Timeout;
}

// OpenAI client (initialized lazily)
let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI | null {
  if (!OPENAI_API_KEY) {
    return null;
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return openaiClient;
}

// Active watchers per pane
const activeWatchers = new Map<string, WatcherState>();

// Constants for watcher behavior
const POLL_INTERVAL_MS = 1500;
const MIN_UPDATE_INTERVAL_MS = 2000;
const IDLE_TIMEOUT_MS = 30000;
const SUMMARIZE_THRESHOLD = 500;

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
 * Capture current content of a tmux pane.
 */
function capturePane(paneId: string): string {
  try {
    return execSync(`tmux capture-pane -p -t ${paneId}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * Summarize output using OpenAI if it exceeds threshold.
 */
async function summarizeOutput(text: string): Promise<string> {
  if (text.length <= SUMMARIZE_THRESHOLD) {
    return text;
  }

  const openai = getOpenAI();
  if (!openai) {
    // Truncate if no API key
    return text.slice(0, SUMMARIZE_THRESHOLD) + '... (truncated)';
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Summarize this terminal output concisely (max 200 chars)',
        },
        { role: 'user', content: text },
      ],
      max_tokens: 100,
    });
    return response.choices[0]?.message?.content || text.slice(0, SUMMARIZE_THRESHOLD) + '...';
  } catch (error) {
    console.error('OpenAI summarization failed:', error);
    return text.slice(0, SUMMARIZE_THRESHOLD) + '... (truncated)';
  }
}

/**
 * Stop watching a pane.
 */
function stopWatching(paneId: string): void {
  const watcher = activeWatchers.get(paneId);
  if (watcher) {
    clearInterval(watcher.intervalId);
    activeWatchers.delete(paneId);
    console.log(`Stopped watching pane ${paneId}`);
  }
}

/**
 * Start watching a pane for output changes.
 */
function startWatching(bot: TelegramBot, paneId: string, messageId: number): void {
  // Stop existing watcher if any
  stopWatching(paneId);

  const initialContent = capturePane(paneId);

  const watcher: WatcherState = {
    paneId,
    lastContent: initialContent,
    lastUpdate: Date.now(),
    messageId,
    intervalId: setInterval(() => {
      void pollPane(bot, paneId);
    }, POLL_INTERVAL_MS),
  };

  activeWatchers.set(paneId, watcher);
  console.log(`Started watching pane ${paneId}`);
}

/**
 * Poll a pane for new output.
 */
async function pollPane(bot: TelegramBot, paneId: string): Promise<void> {
  const watcher = activeWatchers.get(paneId);
  if (!watcher) return;

  const currentContent = capturePane(paneId);
  const now = Date.now();

  // Check for new content
  if (currentContent !== watcher.lastContent) {
    // Find new content (diff from last)
    const newContent = currentContent.slice(watcher.lastContent.length).trim();

    if (newContent && now - watcher.lastUpdate >= MIN_UPDATE_INTERVAL_MS) {
      try {
        const summary = await summarizeOutput(newContent);
        await bot.editMessageText(`📺 ${paneId}\n\n${summary}`, {
          chat_id: chatId,
          message_id: watcher.messageId,
        });
      } catch (error) {
        // Message might be unchanged or other error - ignore
      }

      watcher.lastContent = currentContent;
      watcher.lastUpdate = now;
    } else if (newContent) {
      // Content changed but not time to update yet, just track it
      watcher.lastContent = currentContent;
    }
  }

  // Check for idle timeout
  if (now - watcher.lastUpdate >= IDLE_TIMEOUT_MS) {
    try {
      const finalContent = capturePane(paneId);
      const summary = await summarizeOutput(finalContent.slice(-1000)); // Last 1000 chars
      await bot.editMessageText(`✅ ${paneId} (idle)\n\n${summary}`, {
        chat_id: chatId,
        message_id: watcher.messageId,
      });
    } catch {
      // Ignore edit errors
    }
    stopWatching(paneId);
  }
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

    // Send watching message and start output capture
    const watchMsg = await bot.sendMessage(msg.chat.id, `📺 Watching ${paneId}...`, {
      reply_to_message_id: msg.message_id,
    });

    startWatching(bot, paneId, watchMsg.message_id);
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
