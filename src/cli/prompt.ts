import readline from "node:readline";
import { c, width, termWidth } from "./term.js";

/** Esc: leave the current question (skip a setup step, or go back in the settings menu). */
export class BackSignal extends Error {
  constructor() {
    super("back");
  }
}
/** Ctrl+C: stop the whole session. */
export class CancelSignal extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface Option<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface TextQuestion {
  message: string;
  initial?: string;
  placeholder?: string;
  hint?: string;
  validate?: (v: string) => string | null;
}

export interface Prompter {
  text(q: TextQuestion): Promise<string>;
  password(q: TextQuestion): Promise<string>;
  /** Multi-line paste (e.g. a PEM key). Ends at a line matching `until` or Ctrl+D. */
  multiline(q: TextQuestion & { until?: RegExp }): Promise<string>;
  select<T>(q: { message: string; options: Option<T>[]; initial?: T; hint?: string }): Promise<T>;
  multiselect<T>(q: { message: string; options: Option<T>[]; initial?: T[]; hint?: string; min?: number }): Promise<T[]>;
  confirm(q: { message: string; initial?: boolean }): Promise<boolean>;
  /** Wait for Enter (used while the user does something in another app). */
  pause(message: string): Promise<void>;
}

const KEYS_SELECT = "↑↓ 이동 · Enter 선택 · Esc 건너뛰기/뒤로";
const KEYS_MULTI = "↑↓ 이동 · Space 선택/해제 · Enter 확인 · Esc 뒤로";
const KEYS_TEXT = "Enter 확인 · Esc 건너뛰기/뒤로";

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

/**
 * Interactive prompts in the style of Claude Code: numbered options with a ❯ cursor, input in a
 * rounded box, compact answer echo afterwards. Raw mode is only on while a question is shown, so
 * child processes (CLI logins) get a normal terminal in between.
 */
export class TtyPrompter implements Prompter {
  constructor(
    private input: NodeJS.ReadStream = process.stdin,
    private output: NodeJS.WriteStream = process.stdout,
  ) {}

  private ask<R>(render: () => string[], onKey: (str: string | undefined, key: Key, done: (r: R, echo: string) => void) => void): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      let prevRows = 0;
      const cols = () => this.output.columns || 80;
      const rows = (lines: string[]) => lines.reduce((n, l) => n + Math.max(1, Math.ceil(width(l) / cols())), 0);
      const clear = () => {
        if (!prevRows) return;
        this.output.write(`\r${prevRows > 1 ? `\x1b[${prevRows - 1}A` : ""}\x1b[0J`);
      };
      const draw = () => {
        const lines = render();
        clear();
        this.output.write(lines.join("\n"));
        prevRows = rows(lines);
      };
      let finished = false;
      const finish = (fn: () => void, echo?: string) => {
        finished = true;
        this.input.off("keypress", handler);
        if (this.input.isTTY) this.input.setRawMode(false);
        this.input.pause();
        clear();
        if (echo !== undefined) this.output.write(`${echo}\n`);
        this.output.write("\x1b[?25h");
        fn();
      };
      const handler = (str: string | undefined, key: Key = {}) => {
        if (key.ctrl && key.name === "c") return finish(() => reject(new CancelSignal()), c.dim("  (중단됨)"));
        if (key.name === "escape") return finish(() => reject(new BackSignal()));
        onKey(str, key, (r, echo) => finish(() => resolve(r), echo));
        if (!finished) draw();
      };
      readline.emitKeypressEvents(this.input);
      if (this.input.isTTY) this.input.setRawMode(true);
      this.input.resume();
      this.input.on("keypress", handler);
      this.output.write("\x1b[?25l");
      draw();
    });
  }

  private echo(message: string, answer: string) {
    return `${c.accent("✔")} ${message} ${c.dim("›")} ${answer}`;
  }

  private header(message: string) {
    return `${c.accent("?")} ${c.bold(message)}`;
  }

  private input_(q: TextQuestion, mode: "text" | "password" | "multiline", until?: RegExp): Promise<string> {
    let value = q.initial ?? "";
    let cursor = value.length;
    let error: string | null = null;
    const boxW = Math.min(termWidth() - 2, 72);
    const render = () => {
      let content: string;
      if (mode === "multiline") {
        const lines = value.split("\n");
        content = `${c.accent(">")} ${value ? c.dim(`${lines.length}줄 — ${(lines[lines.length - 1] ?? "").slice(0, 32)}`) : c.dim(q.placeholder ?? "")}`;
      } else if (!value && q.placeholder) {
        content = `${c.accent(">")} ${c.inverse(q.placeholder[0] ?? " ")}${c.dim(q.placeholder.slice(1))}`;
      } else {
        const shown = mode === "password" ? "•".repeat(value.length) : value;
        let before = shown.slice(0, cursor);
        let after = shown.slice(cursor + 1);
        // keep the cursor visible inside the box
        const room = boxW - 7;
        while (width(before) + 1 + width(after) > room && after.length) after = after.slice(0, -1);
        while (width(before) + 1 > room && before.length) before = before.slice(1);
        content = `${c.accent(">")} ${before}${c.inverse(shown[cursor] ?? " ")}${after}`;
      }
      return [
        this.header(q.message),
        c.gray(`╭${"─".repeat(boxW - 2)}╮`),
        `${c.gray("│")} ${content}${" ".repeat(Math.max(0, boxW - 4 - width(content)))} ${c.gray("│")}`,
        c.gray(`╰${"─".repeat(boxW - 2)}╯`),
        error ? `  ${c.red(error)}` : `  ${c.dim(q.hint ?? (mode === "multiline" ? "붙여 넣으면 끝 줄에서 자동으로 확인됩니다 · Ctrl+D 확인 · Esc 뒤로" : KEYS_TEXT))}`,
      ];
    };
    return this.ask<string>(render, (str, key, done) => {
      const submit = () => {
        const v = mode === "multiline" ? value.trim() : value.trim();
        const err = q.validate?.(v) ?? null;
        if (err) {
          error = err;
          return;
        }
        const echoValue = mode === "password" ? c.dim(v ? "••••••••" : "(비움)") : mode === "multiline" ? c.dim(`${v.split("\n").length}줄`) : v ? c.accent(v) : c.dim("(비움)");
        done(v, this.echo(q.message, echoValue));
      };
      error = null;
      if (mode === "multiline") {
        if (key.ctrl && key.name === "d") return submit();
        if (key.name === "return" || key.name === "enter") {
          const last = value.split("\n").pop() ?? "";
          if (until && until.test(last)) return submit();
          value += "\n";
          return;
        }
        if (key.name === "backspace") {
          value = value.slice(0, -1);
          return;
        }
        if (str && !key.ctrl && !key.meta) value += str.replace(/\r/g, "\n");
        if (until && until.test(value.trim().split("\n").pop() ?? "")) return submit();
        return;
      }
      if (key.name === "return" || key.name === "enter") return submit();
      if (key.name === "backspace") {
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor--;
        }
        return;
      }
      if (key.name === "delete") {
        value = value.slice(0, cursor) + value.slice(cursor + 1);
        return;
      }
      if (key.name === "left") cursor = Math.max(0, cursor - 1);
      else if (key.name === "right") cursor = Math.min(value.length, cursor + 1);
      else if (key.name === "home" || (key.ctrl && key.name === "a")) cursor = 0;
      else if (key.name === "end" || (key.ctrl && key.name === "e")) cursor = value.length;
      else if (key.ctrl && key.name === "u") {
        value = value.slice(cursor);
        cursor = 0;
      } else if (str && !key.ctrl && !key.meta && ![...str].some((ch) => ch.charCodeAt(0) < 0x20)) {
        value = value.slice(0, cursor) + str + value.slice(cursor);
        cursor += str.length;
      }
    });
  }

  text(q: TextQuestion) {
    return this.input_(q, "text");
  }
  password(q: TextQuestion) {
    return this.input_(q, "password");
  }
  multiline(q: TextQuestion & { until?: RegExp }) {
    return this.input_(q, "multiline", q.until);
  }

  select<T>(q: { message: string; options: Option<T>[]; initial?: T; hint?: string }): Promise<T> {
    let i = Math.max(0, q.options.findIndex((o) => o.value === q.initial));
    const render = () => [
      this.header(q.message),
      ...q.options.map((o, n) => {
        const label = `${n + 1}. ${o.label}`;
        const hint = o.hint ? `  ${c.dim(`· ${o.hint}`)}` : "";
        return n === i ? `  ${c.accent(`❯ ${label}`)}${hint}` : `    ${label}${hint}`;
      }),
      `  ${c.dim(q.hint ?? KEYS_SELECT)}`,
    ];
    return this.ask<T>(render, (str, key, done) => {
      if (key.name === "up" || key.name === "k") i = (i - 1 + q.options.length) % q.options.length;
      else if (key.name === "down" || key.name === "j" || key.name === "tab") i = (i + 1) % q.options.length;
      else if (str && /^[1-9]$/.test(str) && Number(str) <= q.options.length) {
        i = Number(str) - 1;
        done(q.options[i]!.value, this.echo(q.message, c.accent(q.options[i]!.label)));
      } else if (key.name === "return" || key.name === "enter") done(q.options[i]!.value, this.echo(q.message, c.accent(q.options[i]!.label)));
    });
  }

  multiselect<T>(q: { message: string; options: Option<T>[]; initial?: T[]; hint?: string; min?: number }): Promise<T[]> {
    let i = 0;
    const picked = new Set<number>(q.options.map((o, n) => (q.initial?.includes(o.value) ? n : -1)).filter((n) => n >= 0));
    let error: string | null = null;
    const render = () => [
      this.header(q.message),
      ...q.options.map((o, n) => {
        const mark = picked.has(n) ? c.accent("◉") : c.dim("◯");
        const hint = o.hint ? `  ${c.dim(`· ${o.hint}`)}` : "";
        return n === i ? `  ${c.accent("❯")} ${mark} ${c.accent(o.label)}${hint}` : `    ${mark} ${o.label}${hint}`;
      }),
      error ? `  ${c.red(error)}` : `  ${c.dim(q.hint ?? KEYS_MULTI)}`,
    ];
    return this.ask<T[]>(render, (str, key, done) => {
      error = null;
      if (key.name === "up" || key.name === "k") i = (i - 1 + q.options.length) % q.options.length;
      else if (key.name === "down" || key.name === "j" || key.name === "tab") i = (i + 1) % q.options.length;
      else if (key.name === "space" || str === " ") {
        if (picked.has(i)) picked.delete(i);
        else picked.add(i);
      } else if (str === "a") {
        if (picked.size === q.options.length) picked.clear();
        else q.options.forEach((_, n) => picked.add(n));
      }
      else if (key.name === "return" || key.name === "enter") {
        if (picked.size < (q.min ?? 0)) {
          error = `${q.min}개 이상 선택하세요 (Space)`;
          return;
        }
        const vals = q.options.filter((_, n) => picked.has(n));
        done(
          vals.map((o) => o.value),
          this.echo(q.message, vals.length ? c.accent(vals.map((o) => o.label).join(", ")) : c.dim("(없음)")),
        );
      }
    });
  }

  confirm(q: { message: string; initial?: boolean }): Promise<boolean> {
    return this.select({
      message: q.message,
      options: [
        { value: true, label: "예" },
        { value: false, label: "아니요" },
      ],
      initial: q.initial ?? true,
    });
  }

  pause(message: string): Promise<void> {
    return this.ask<void>(
      () => [`${c.accent("?")} ${c.bold(message)}`, `  ${c.dim("Enter 계속 · Esc 건너뛰기")}`],
      (_s, key, done) => {
        if (key.name === "return" || key.name === "enter") done(undefined, `${c.accent("✔")} ${message}`);
      },
    );
  }
}

export const BACK = Symbol("back");

/** Deterministic prompter for tests: answers are consumed in order; BACK simulates Esc. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  constructor(private answers: unknown[]) {}

  private next(message: string): unknown {
    this.asked.push(message);
    if (!this.answers.length) throw new Error(`no scripted answer for: ${message}`);
    const a = this.answers.shift();
    if (a === BACK) throw new BackSignal();
    return a;
  }
  private textLike(q: TextQuestion) {
    const v = String(this.next(q.message) ?? "").trim();
    const err = q.validate?.(v);
    if (err) throw new Error(`invalid answer for "${q.message}": ${err}`);
    return Promise.resolve(v);
  }
  text(q: TextQuestion) {
    return this.textLike(q);
  }
  password(q: TextQuestion) {
    return this.textLike(q);
  }
  multiline(q: TextQuestion) {
    return this.textLike(q);
  }
  select<T>(q: { message: string; options: Option<T>[] }) {
    const a = this.next(q.message) as T;
    if (!q.options.some((o) => o.value === a)) throw new Error(`"${String(a)}" is not an option for "${q.message}": ${q.options.map((o) => String(o.value)).join(", ")}`);
    return Promise.resolve(a);
  }
  multiselect<T>(q: { message: string; options: Option<T>[] }) {
    const a = this.next(q.message) as T[];
    for (const v of a) if (!q.options.some((o) => o.value === v)) throw new Error(`"${String(v)}" is not an option for "${q.message}"`);
    return Promise.resolve(a);
  }
  confirm(q: { message: string }) {
    return Promise.resolve(Boolean(this.next(q.message)));
  }
  pause(message: string) {
    this.next(message);
    return Promise.resolve();
  }
  get remaining() {
    return this.answers.length;
  }
}
