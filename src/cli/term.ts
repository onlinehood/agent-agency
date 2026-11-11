/**
 * Terminal rendering for the interactive setup/config CLI: colors, display width (Korean is
 * double-width), boxes, status lines, dot-art characters and a spinner. No dependencies.
 */
import { mascot } from "./sprites.js";

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
// `docker compose exec` can report 80 columns before the real size arrives, so the host's width
// (COLUMNS, passed by ./aa) wins when it is smaller. Phones are often only 40–50 columns wide.
export function columnsOf(stream: { columns?: number } = process.stdout): number {
  const known = [stream.columns, Number(process.env.COLUMNS)].filter((n): n is number => typeof n === "number" && n > 0);
  return known.length ? Math.min(...known) : 80;
}
export const termWidth = () => Math.max(30, Math.min(columnsOf(), 100));

/** Word-wrap one (possibly coloured) line to a display width; colours carry over to the next line. */
export function wrapLine(s: string, max: number): string[] {
  if (max < 4 || width(s) <= max) return [s];
  const out: string[] = [];
  let line = "";
  let lineW = 0;
  let sgr = ""; // colour active at the current point
  let lastSpace = -1; // index in `line` just after the last space
  const flush = (cut: number) => {
    const head = line.slice(0, cut).replace(/ +$/, "");
    const rest = line.slice(cut).replace(/^ +/, "");
    out.push(`${head}${sgr ? "\x1b[0m" : ""}`);
    line = `${sgr}${rest}`;
    lineW = width(line);
    lastSpace = -1;
  };
  for (let i = 0; i < s.length; ) {
    // eslint-disable-next-line no-control-regex
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) {
      line += m[0];
      // eslint-disable-next-line no-control-regex
      sgr = /^\x1b\[0?m$/.test(m[0]) ? "" : sgr + m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    i += ch.length;
    const w = width(ch);
    if (lineW + w > max) {
      if (ch === " ") {
        flush(line.length);
        continue;
      }
      flush(lastSpace > 0 ? lastSpace : line.length);
    }
    line += ch;
    lineW += w;
    if (ch === " ") lastSpace = line.length;
  }
  if (width(line)) out.push(line);
  return out;
}

/** Rounded box, Claude Code style. `title` sits in the top border. */
export function box(input: string[], opts: { title?: string; color?: (s: string) => string; width?: number } = {}): string {
  const color = opts.color ?? c.accent;
  // Never wider than the screen (2 columns spare so the terminal does not auto-wrap the border).
  const maxText = Math.max(10, termWidth() - 6);
  const lines = input.flatMap((l) => wrapLine(l, maxText));
  const inner = Math.min(maxText, Math.max(opts.width ?? 0, ...lines.map((l) => width(l)), opts.title ? width(opts.title) + 4 : 0)) + 2;
  const top = opts.title ? `╭─── ${opts.title} ${"─".repeat(Math.max(0, inner - width(opts.title) - 5))}╮` : `╭${"─".repeat(inner)}╮`;
  const body = lines.map((l) => `${color("│")} ${pad(l, inner - 2)} ${color("│")}`);
  return [color(top), ...body, color(`╰${"─".repeat(inner)}╯`)].join("\n");
}

/* ------------------------------------------------ dot art */

/** Welcome banner: the mascot on the left, title and hints on the right, in an orange box. */
export function welcome(version: string, subtitle: string, hints: string[]): string {
  const art = mascot();
  const text = Math.min(termWidth() - 6, 72); // text width inside the box
  const artW = Math.max(...art.map((l) => width(l)));
  // The right column wraps within its own width so wrapped words stay aligned beside the mascot.
  const right = [`${c.bold("✻ AgentAgency")} ${c.dim(`v${version}`)}`, c.dim("Your Agents. Your Agency."), subtitle].flatMap((l) => wrapLine(l, text - artW - 4));
  const rows = Math.max(art.length, right.length);
  const artTop = Math.floor((rows - art.length) / 2);
  const textTop = Math.floor((rows - right.length) / 2);
  const lines: string[] = [""];
  for (let i = 0; i < rows; i++) lines.push(` ${pad(art[i - artTop] ?? "", artW)}   ${right[i - textTop] ?? ""}`);
  lines.push("", ...hints.flatMap((h) => packParts(h.split(" · "), text - 1).map((l) => ` ${c.dim(l)}`)));
  return box(lines, { width: text });
}

/** Join "a · b · c" parts into as few lines as fit, breaking only between parts. */
export function packParts(parts: string[], max: number): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last !== undefined && width(`${last} · ${p}`) <= max) out[out.length - 1] = `${last} · ${p}`;
    else out.push(p);
  }
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
    // The line must never wrap: "\r" only returns to the start of the last wrapped row, so a
    // wrapped spinner leaves a copy of itself on every frame (narrow phone terminals).
    const max = Math.max(10, columnsOf(stream) - 1);
    let head = `${FRAMES[i++ % FRAMES.length]!} ${label}…`;
    let tail = ` (${secs}s · Ctrl+C 중단)`;
    if (width(head + tail) > max) tail = ` ${secs}s`;
    if (width(head + tail) > max) head = truncate(head, Math.max(4, max - width(tail)));
    stream.write(`\r\x1b[2K${c.accent(head)}${c.dim(tail)}`);
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
