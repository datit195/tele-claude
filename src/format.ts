/**
 * Convert Claude Code markdown output to Telegram-compatible HTML.
 *
 * Telegram's HTML parse mode supports a small tag whitelist:
 *   <b> <i> <u> <s> <code> <pre> <a> <blockquote> <tg-spoiler>.
 *
 * This converter maps common markdown to that subset. Tables get special
 * handling because Telegram doesn't render them natively AND its <pre>
 * block wraps instead of scrolling horizontally on mobile (desktop has
 * horizontal scroll, mobile clients don't). We use a width heuristic:
 *
 *   * Narrow tables (total row width <= PRE_MAX_WIDTH) stay as aligned
 *     monospace <pre> blocks — columns look crisp and fit on a phone.
 *   * Wider tables flatten to vertical bullet blocks — first column
 *     bolded as the row label, remaining columns as sub-lines.
 */

import { htmlEscape } from "./util.js";

// Placeholder sentinels (matching the Python version's \x00-delimited form).
const CODE_PLACEHOLDER = (i: number) => `\x00C${i}\x00`;
const INLINE_PLACEHOLDER = (i: number) => `\x00I${i}\x00`;
const TABLE_PLACEHOLDER = (i: number) => `\x00T${i}\x00`;

// Max total monospace width that fits without wrapping on a typical
// mobile Telegram client at default font size. Above this we switch
// from aligned <pre> tables to vertical bullet blocks.
const PRE_MAX_WIDTH = 34;

const ROW_RE = /^\s*\|.*\|\s*$/;
const SEP_RE = /^\s*\|[\s\-:|]+\|\s*$/;

export function convert(md: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const tables: string[] = [];

  // 1. Fenced code blocks: protect from everything.
  md = md.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_all, lang: string, body: string) => {
    const cls = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre><code${cls}>${htmlEscape(body)}</code></pre>`);
    return CODE_PLACEHOLDER(codeBlocks.length - 1);
  });

  // 2. Tables: handle on raw markdown so we can clean cells ourselves.
  md = stashTables(md, tables);

  // 3. Inline code in non-table, non-fence text.
  md = md.replace(/`([^`\n]+)`/g, (_all, body: string) => {
    inlineCodes.push(`<code>${htmlEscape(body)}</code>`);
    return INLINE_PLACEHOLDER(inlineCodes.length - 1);
  });

  // 4. Escape HTML in remaining text.
  md = htmlEscape(md);

  // 5. Markdown → HTML tags.
  md = md.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "<b>$1</b>");
  md = md.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  md = md.replace(/(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, "<i>$1</i>");
  md = md.replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, "<i>$1</i>");
  md = md.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  md = md.replace(/^>[ \t]*(.+)$/gm, "<blockquote>$1</blockquote>");
  md = md.replace(/^([ \t]*)[-*+][ \t]+(.+)$/gm, "$1• $2");
  md = md.replace(/^-{3,}$/gm, "·····");

  // 6. Restore placeholders (tables first so their inner HTML stays intact).
  tables.forEach((block, i) => {
    md = md.split(TABLE_PLACEHOLDER(i)).join(block);
  });
  inlineCodes.forEach((block, i) => {
    md = md.split(INLINE_PLACEHOLDER(i)).join(block);
  });
  codeBlocks.forEach((block, i) => {
    md = md.split(CODE_PLACEHOLDER(i)).join(block);
  });

  return md;
}

function stashTables(text: string, sink: string[]): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i];
    const sepLine = lines[i + 1];
    if (
      headerLine !== undefined &&
      sepLine !== undefined &&
      ROW_RE.test(headerLine) &&
      SEP_RE.test(sepLine)
    ) {
      const header = splitRow(headerLine);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const current = lines[i];
        if (current === undefined) break;
        if (!ROW_RE.test(current) || SEP_RE.test(current)) break;
        rows.push(splitRow(current));
        i += 1;
      }
      sink.push(renderTable(header, rows));
      out.push(TABLE_PLACEHOLDER(sink.length - 1));
    } else {
      out.push(headerLine ?? "");
      i += 1;
    }
  }
  return out.join("\n");
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map(cleanCell);
}

/** Strip markdown decorations; don't escape yet (done after padding). */
function cleanCell(cell: string): string {
  cell = cell.trim();
  cell = cell.replace(/`([^`]+)`/g, "$1");
  cell = cell.replace(/\*\*([^*]+)\*\*/g, "$1");
  cell = cell.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  return cell;
}

function renderTable(header: string[], rows: string[][]): string {
  if (header.length === 0) return "";
  const n = header.length;
  const normalised: string[][] = [
    header,
    ...rows.map((r) => [...r, ...Array<string>(Math.max(0, n - r.length)).fill("")]),
  ];
  const widths: number[] = [];
  for (let col = 0; col < n; col++) {
    let max = 0;
    for (const row of normalised) {
      const cell = row[col] ?? "";
      if (cell.length > max) max = cell.length;
    }
    widths.push(max);
  }
  const totalWidth = widths.reduce((a, b) => a + b, 0) + 2 * (n - 1);
  if (totalWidth <= PRE_MAX_WIDTH) {
    return renderTableMonospace(header, normalised.slice(1), widths, n);
  }
  return renderTableVertical(header, normalised.slice(1), n);
}

function renderTableMonospace(
  header: string[],
  rows: string[][],
  widths: number[],
  n: number,
): string {
  const fmt = (cells: string[]): string => {
    const padded: string[] = [];
    for (let c = 0; c < n; c++) {
      const cell = cells[c] ?? "";
      const width = widths[c] ?? 0;
      padded.push(cell.padEnd(width, " "));
    }
    return padded.join("  ").trimEnd();
  };
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const plain = [fmt(header), sep, ...rows.map(fmt)];
  const body = plain.map(htmlEscape).join("\n");
  return `<pre>${body}</pre>`;
}

function renderTableVertical(header: string[], rows: string[][], n: number): string {
  const blocks: string[] = [];
  for (const row of rows) {
    const first = htmlEscape(row[0] ?? "");
    if (n === 1) {
      blocks.push(`• <b>${first}</b>`);
      continue;
    }
    if (n === 2) {
      const second = htmlEscape(row[1] ?? "");
      let block = `• <b>${first}</b>`;
      if (second) block += `\n  → ${second}`;
      blocks.push(block);
      continue;
    }
    const lines = [`• <b>${first}</b>`];
    for (let i = 1; i < n; i++) {
      const cell = htmlEscape(row[i] ?? "");
      lines.push(`  <b>${htmlEscape(header[i] ?? "")}:</b> ${cell}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
