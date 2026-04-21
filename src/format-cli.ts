#!/usr/bin/env node
/** CLI: read markdown from stdin, write Telegram HTML to stdout. */

import { readFileSync } from "node:fs";
import { convert } from "./format.js";

function main(): void {
  const input = readFileSync(0, "utf8");
  process.stdout.write(convert(input));
}

main();
