import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mascot } from "../src/cli/sprites.js";

/**
 * install.sh runs before Docker/Node exist, so it carries a pre-rendered copy of the banner
 * character. This test keeps that copy in sync with src/cli/sprites.ts.
 * `npm run art` (UPDATE_ART=1) rewrites the block.
 */
const FILE = path.resolve(__dirname, "../install.sh");
const ansiC = (s: string) => `$'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replaceAll("\x1b", "\\e")}'`;

function block(): string {
  const arr = (name: string, lines: string[]) => `${name}=(\n${lines.map((l) => `  ${ansiC(l)}`).join("\n")}\n)`;
  return ["# >>> art (generated from src/cli/sprites.ts by `npm run art` — do not edit by hand)", arr("TUI_ART_256", mascot("256")), arr("TUI_ART_PLAIN", mascot("none")), "# <<< art"].join("\n");
}

describe("installer banner art", () => {
  it("matches the sprite source", () => {
    const src = fs.readFileSync(FILE, "utf8");
    const re = /# >>> art[^\n]*\n[\s\S]*?# <<< art/;
    const want = block();
    if (process.env.UPDATE_ART) fs.writeFileSync(FILE, src.replace(re, () => want));
    expect(fs.readFileSync(FILE, "utf8").match(re)?.[0], "run: npm run art").toBe(want);
  });
});
