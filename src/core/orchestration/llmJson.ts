/**
 * Extract a JSON object from LLM output (fenced or inline). Returns null when not parseable,
 * so callers can fall back safely instead of inventing data.
 */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim()) as T;
    } catch {}
  }
  return null;
}

export function asStringArray(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.trim()).slice(0, max).map((x) => (x as string).trim());
}
