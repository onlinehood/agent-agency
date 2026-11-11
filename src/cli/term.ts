/**
 * Terminal rendering for the interactive setup/config CLI: colors, display width (Korean is
 * double-width), boxes, status lines, dot-art characters and a spinner. No dependencies.
 */
import { avatar, MASCOT, type Look, type Mood } from "./sprites.js";

const useColor = () => !process.env.NO_COLOR && process.env.TERM !== "dumb";
const sgr = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  accent: sgr("38;5;173"), // warm orange
  accentBold: sgr("1;38;5;173"),
  bold: sgr("1"),
  dim: sgr("2"),
  gray: sgr("90"),
  green: sgr("32"),
  red: sgr("31"),
  yellow: sgr("33"),
  blue: sgr("38;5;110"),
  inverse: sgr("7"),
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x2600 && cp <= 0x26ff && cp !== 0x2610 && cp !== 0x2611) ||
    (cp >= 0x1fa70 && cp <= 0x1faff)
  );
}

/** Display width in terminal cells (ANSI stripped, wide characters count 2, combining marks 0). */
export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || cp === 0x200d || (cp >= 0x300 && cp <= 0x36f)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

export const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

/** Truncate plain text to a display width (used for user-provided values). */
export function truncate(s: string, w: number): string {
  if (width(s) <= w) return s;
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > w - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// COLUMNS covers `docker compose exec -T` (no TTY inside the container, so no width of its own).
export const termWidth = () => Math.max(40, Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 80, 100));

/** Rounded box, Claude Code style. `title` sits in the top border. */
export function box(lines: string[], opts: { title?: string; color?: (s: string) => string; width?: number } = {}): string {
  const color = opts.color ?? c.accent;
  const inner = Math.max(opts.width ?? 0, ...lines.map((l) => width(l)), opts.title ? width(opts.title) + 4 : 0) + 2;
  const top = opts.title ? `╭─── ${opts.title} ${"─".repeat(Math.max(0, inner - width(opts.title) - 5))}╮` : `╭${"─".repeat(inner)}╮`;
  const body = lines.map((l) => `${color("│")} ${pad(l, inner - 2)} ${color("│")}`);
  return [color(top), ...body, color(`╰${"─".repeat(inner)}╯`)].join("\n");
}

/* ------------------------------------------------ dot art */

/** Welcome banner: the mascot on the left, title and hints on the right, in an orange box. */
export function welcome(version: string, subtitle: string, hints: string[], look: Look = MASCOT): string {
  const art = avatar(look, "happy");
  const right = [`${c.bold("✻ AgentAgency")} ${c.dim(`v${version}`)}`, c.dim("Your Agents. Your Agency."), "", subtitle];
  const top = Math.max(0, Math.floor((art.length - right.length) / 2));
  const artW = Math.max(...art.map((l) => width(l)));
  const lines: string[] = [""];
  for (let i = 0; i < art.length; i++) lines.push(` ${pad(art[i]!, artW)}   ${right[i - top] ?? ""}`);
  lines.push("", ...hints.map((h) => ` ${c.dim(h)}`));
  return box(lines, { width: Math.min(termWidth() - 4, 72) });
}

export interface PartyMember {
  look: Look;
  mood?: Mood;
  name: string;
  note?: string;
}

/** Characters side by side (bottom-aligned) with names under them; wraps to the terminal width. */
export function party(members: PartyMember[], maxWidth = termWidth(), opts: { oneRow?: boolean } = {}): string[] {
  const cells = members.map((m) => {
    const art = avatar(m.look, m.mood ?? "idle");
    const w = Math.max(...art.map((l) => width(l)), width(m.name) + 2, width(m.note ?? ""));
    return { art, w, m };
  });
  const out: string[] = [];
  let row: typeof cells = [];
  const flush = () => {
    if (!row.length) return;
    const h = Math.max(...row.map((x) => x.art.length));
    for (let i = 0; i < h; i++) out.push(row.map((x) => pad(x.art[i - (h - x.art.length)] ?? "", x.w)).join("  "));
    const center = (s: string, w: number) => pad(" ".repeat(Math.max(0, Math.floor((w - width(s)) / 2))) + s, w);
    out.push(row.map((x) => center(c.bold(x.m.name), x.w)).join("  "));
    if (row.some((x) => x.m.note)) out.push(row.map((x) => center(c.dim(x.m.note ?? ""), x.w)).join("  "));
    out.push("");
    row = [];
  };
  let used = 0;
  for (const cell of cells) {
    if (row.length && used + 2 + cell.w > maxWidth) {
      if (opts.oneRow) break;
      flush();
      used = 0;
    }
    used += (row.length ? 2 : 0) + cell.w;
    row.push(cell);
  }
  flush();
  return out;
}

/* ------------------------------------------------ status lines */

export const ICON = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗"), info: c.dim("·") };
export type Tone = keyof typeof ICON;

/** "⏺ Title" — a step header. */
export const stepLine = (title: string) => `${c.accent("⏺")} ${c.bold(title)}`;
/** "  ⎿  detail" — a result under a step. */
export const resultLine = (text: string, tone?: Tone) => `  ${c.dim("⎿")}  ${tone ? `${ICON[tone]} ` : ""}${text}`;
/** Indented continuation under a result. */
export const subLine = (text: string) => `     ${text}`;

/* ------------------------------------------------ spinner */

const FRAMES = ["·", "✢", "✳", "∗", "✻", "✽", "✻", "∗", "✳", "✢"];

export interface Spinner {
  stop(final?: string): void;
}

export function spinner(label: string, stream: NodeJS.WriteStream = process.stdout): Spinner {
  if (!stream.isTTY) {
    stream.write(`${c.accent("✻")} ${label}…\n`);
    return { stop: (final) => final && stream.write(`${final}\n`) };
  }
  let i = 0;
  const started = Date.now();
  const draw = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    stream.write(`\r\x1b[2K${c.accent(FRAMES[i++ % FRAMES.length]!)} ${c.accent(`${label}…`)} ${c.dim(`(${secs}s · Ctrl+C 중단)`)}`);
  };
  stream.write("\x1b[?25l");
  draw();
  const t = setInterval(draw, 120);
  return {
    stop(final) {
      clearInterval(t);
      stream.write(`\r\x1b[2K\x1b[?25h${final ? `${final}\n` : ""}`);
    },
  };
}
