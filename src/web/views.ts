/** Minimal server-rendered views for the setup wizard and admin console (no external assets). */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{--bg:#f6f7f9;--fg:#1d2330;--muted:#5d6676;--card:#fff;--line:#dde1e7;--accent:#2f5bea;--ok:#1a7f45;--warn:#a46200;--fail:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e6e9ef;--muted:#9aa3b2;--card:#1b2029;--line:#2b323e;--accent:#7b9bff;--ok:#4cc38a;--warn:#f0b05a;--fail:#ff7b72}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
header b{font-size:17px}header nav{display:flex;gap:12px;flex-wrap:wrap}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--accent)}
main{max-width:1040px;margin:0 auto;padding:20px 16px 64px}
h1{font-size:22px;margin:4px 0 16px}h2{font-size:17px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
label{display:block;font-weight:600;margin:10px 0 4px}small,.muted{color:var(--muted)}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:110px;font-family:ui-monospace,monospace;font-size:13px}
button{margin-top:12px;padding:8px 14px;border:0;border-radius:7px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}button.danger{background:var(--fail)}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl{overflow-x:auto}
.s-ok{color:var(--ok)}.s-warn{color:var(--warn)}.s-fail,.s-unsupported{color:var(--fail)}
.steps{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}.steps span{padding:4px 10px;border-radius:99px;border:1px solid var(--line);font-size:13px}.steps .done{border-color:var(--ok);color:var(--ok)}.steps .cur{border-color:var(--accent);color:var(--accent);font-weight:700}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:14px;border:1px solid var(--line)}.flash.err{border-color:var(--fail);color:var(--fail)}.flash.ok{border-color:var(--ok);color:var(--ok)}
code,pre{font-family:ui-monospace,monospace;font-size:13px}pre{white-space:pre-wrap;background:var(--bg);padding:10px;border-radius:7px;border:1px solid var(--line)}
.inline{display:flex;gap:8px;align-items:center}.inline input[type=checkbox]{width:auto}
`;

export function layout(title: string, body: string, opts: { nav?: boolean; flash?: { kind: "ok" | "err"; text: string } | null } = {}): string {
  const nav = opts.nav
    ? `<nav><a href="/">대시보드</a><a href="/setup">설정 마법사</a><a href="/agents">에이전트</a><a href="/settings">설정</a><a href="/backups">백업</a><a href="/audit">감사 로그</a><a href="/logout">로그아웃</a></nav>`
    : "";
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind}">${esc(opts.flash.text)}</div>` : "";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · AgentAgency</title><style>${CSS}</style></head><body><header><b>AgentAgency</b><span class="muted">Your Agents. Your Agency.</span>${nav}</header><main>${flash}${body}</main></body></html>`;
}

export function statusCell(status: string): string {
  const icon: Record<string, string> = { ok: "●", warn: "▲", fail: "✕", unsupported: "⊘" };
  const label: Record<string, string> = { ok: "정상", warn: "주의", fail: "실패", unsupported: "미지원" };
  return `<span class="s-${esc(status)}">${icon[status] ?? "·"} ${label[status] ?? esc(status)}</span>`;
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}
