import type { OutboundMessage, Button } from "../core/orchestration/ports.js";

export const TG_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render an outbound message as Telegram HTML, split into chunks under the 4096 limit. */
export function renderHtml(msg: OutboundMessage, limit = TG_LIMIT - 96): string[] {
  const header = msg.header ? `<b>${escapeHtml(msg.header)}</b>\n` : "";
  const body = msg.text;
  const chunks: string[] = [];
  const pieces = splitText(body, limit - header.length - 20);
  pieces.forEach((p, i) => {
    const content = msg.preformatted ? `<pre>${escapeHtml(p)}</pre>` : escapeHtml(p);
    chunks.push((i === 0 ? header : "") + content);
  });
  return chunks.length ? chunks : [header || " "];
}

export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Telegram callback_data is limited to 64 bytes. */
export function keyboard(buttons?: Button[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!buttons?.length) return undefined;
  for (const row of buttons) for (const b of row) if (Buffer.byteLength(b.data) > 64) throw new Error(`callback data too long: ${b.data}`);
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}
