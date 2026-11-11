/**
 * The AgentAgency mascot shown in the setup/config banner and the `aa` menu: a small orange mochi
 * with an antenna. Original design, rendered with half blocks (14×10 px = 5 terminal lines).
 */

type Px = readonly [string, number]; // truecolor hex + hand-picked xterm-256 code

const PALETTE: Record<string, Px> = {
  a: ["#ef5b5b", 203], // antenna tip
  b: ["#8a93a3", 246], // antenna stem
  c: ["#f39a5f", 209], // body
  d: ["#ffc8a0", 223], // highlight
  e: ["#1e1a2b", 234], // eyes
  f: ["#c96a3a", 173], // shade
  g: ["#ff8fa8", 211], // cheeks
};

export const MASCOT_ROWS = [
  ".......aa.....",
  ".......b......",
  ".......b......",
  "....cccccc....",
  "..cddccccccc..",
  ".cdcccccccccc.",
  "cccceccccecccc",
  "cccececcececcf",
  "fccgccffccgccf",
  ".ffffffffffff.",
] as const;

export type ColorMode = "truecolor" | "256" | "none";

export function colorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR || env.TERM === "dumb") return "none";
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");

function sgr(mode: ColorMode, fg: Px | null, bg: Px | null): string {
  if (mode === "none") return "";
  const part = (c: Px, base: number) => (mode === "truecolor" ? `${base};2;${rgb(c[0])}` : `${base};5;${c[1]}`);
  return `\x1b[${[fg ? part(fg, 38) : "", bg ? part(bg, 48) : ""].filter(Boolean).join(";")}m`;
}

/**
 * Half-block rendering: each text cell holds two pixels (top = foreground "▀", bottom =
 * background), so every pixel keeps its own colour. '.' is transparent.
 */
export function renderPixels(rows: readonly string[], palette: Record<string, Px> = PALETTE, mode: ColorMode = colorMode()): string[] {
  const w = Math.max(0, ...rows.map((r) => r.length));
  const px = (ch: string | undefined) => (ch && ch !== "." ? (palette[ch] ?? null) : null);
  const out: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const t = px(rows[y]?.[x]);
      const b = px(rows[y + 1]?.[x]);
      if (!t && !b) line += " ";
      else if (mode === "none") line += t && b ? "█" : t ? "▀" : "▄";
      else if (!b) line += `${sgr(mode, t, null)}▀\x1b[0m`;
      else if (!t) line += `${sgr(mode, b, null)}▄\x1b[0m`;
      else if (t[0] === b[0]) line += `${sgr(mode, t, null)}█\x1b[0m`;
      else line += `${sgr(mode, t, b)}▀\x1b[0m`;
    }
    out.push(line);
  }
  return out;
}

export const mascot = (mode?: ColorMode) => renderPixels(MASCOT_ROWS, PALETTE, mode);
