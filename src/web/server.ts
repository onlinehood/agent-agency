import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import fs from "node:fs";
import path from "node:path";
import type { Runtime } from "../runtime.js";
import { SECRET_REFS, SYSTEM_OWNER } from "../app.js";
import { WebAuth } from "./auth.js";
import { csrfField, esc, layout, statusCell } from "./views.js";
import { runDiagnostics } from "../ops/diagnostics.js";
import { ALL_MODES, allModes, customModes, modeDef, isOrganizationMode } from "../core/organization/modes.js";
import { deleteCustomMode, saveCustomMode } from "../core/organization/customModes.js";
import { describePolicy, resolveExecutionPolicy, setExecutionPolicy } from "../core/execution/policy.js";
import { FLAG_DEFAULTS } from "../core/flags/index.js";
import { runBackup, type BackupRecord } from "../backup/service.js";
import { revokeCredential } from "../security/revoke.js";
import { syncExecutorFlags } from "../executors/flags.js";
import { listBackups, restoreFromFile } from "../backup/backup.js";
import { retentionPolicy } from "../ops/maintenance.js";
import type { User } from "../db/repositories.js";
import type { PersonaPreset } from "../core/types.js";
import { projectStatusKo } from "../core/orchestration/progress.js";
import { SetupService, PERSONAS } from "../setup/service.js";
import { CONTROL_HEADER, controlTokenMatches, type ControlActions } from "../ops/control.js";

const COOKIE = "aa_session";
const STEPS = [
  { key: "admin", label: "1. 관리자" },
  { key: "telegram", label: "2. Telegram" },
  { key: "executors", label: "3. AI 실행기" },
  { key: "github", label: "4. GitHub" },
  { key: "defaults", label: "5. 기본 설정" },
  { key: "diagnostics", label: "6. 진단·운영 시작" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

/**
 * Optional web console: setup pages + admin dashboard (PRD §18, §6.1-11). Setup is normally done
 * in the terminal (`aa setup`); both use the same SetupService. Bound to 127.0.0.1 by default and
 * reached through an SSH tunnel or VPN; no public domain is required.
 */
export function createWebApp(rt: Runtime, opts: { controlToken?: string } = {}): Hono {
  const app = new Hono();
  const ctx = rt.ctx;
  const setup = new SetupService(rt.app, undefined, "web");
  const auth = new WebAuth(ctx.repos);
  const flashes = new Map<string, { kind: "ok" | "err"; text: string }>();

  const sys = <T>(key: string) => ctx.repos.settings.get<T>("system", "", key);
  const setSys = (key: string, v: unknown) => ctx.repos.settings.set("system", "", key, v);

  const primaryUser = (): Promise<User | null> => setup.primaryUser();

  async function currentStep(): Promise<StepKey> {
    if (!(await auth.hasAdmin())) return "admin";
    return setup.currentStep();
  }

  const session = (c: Context) => getCookie(c, COOKIE);
  const flash = (c: Context, kind: "ok" | "err", text: string) => {
    const s = session(c);
    if (s) flashes.set(s, { kind, text });
  };
  const takeFlash = (c: Context) => {
    const s = session(c);
    if (!s) return null;
    const f = flashes.get(s) ?? null;
    flashes.delete(s);
    return f;
  };
  const page = async (c: Context, title: string, body: string) => c.html(layout(title, body, { nav: true, flash: takeFlash(c) }));
  const csrf = async (c: Context) => csrfField(await auth.csrf(session(c) ?? ""));
  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string | File>;
  const str = (v: string | File | undefined) => (typeof v === "string" ? v.trim() : "");

  /* ------------------------------------------------ middleware */

  app.use("*", async (c, next) => {
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'");
    const p = c.req.path;
    // Local control channel for the interactive CLI (same container, token file in the data dir).
    if (p === "/internal/control") {
      if (!controlTokenMatches(opts.controlToken, c.req.header(CONTROL_HEADER))) return c.json({ error: "forbidden" }, 403);
      return next();
    }
    const open = p === "/api/health" || p === "/login" || (p.startsWith("/setup") && !(await auth.hasAdmin()));
    if (!open && !(await auth.verify(session(c)))) {
      if (p.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
      return c.redirect((await auth.hasAdmin()) ? "/login" : "/setup");
    }
    if (c.req.method === "POST" && !open && p !== "/login") {
      const ct = c.req.header("content-type") ?? "";
      const token = ct.includes("form") ? str(((await c.req.parseBody()) as Record<string, string>)._csrf) : c.req.header("x-csrf-token") ?? "";
      if (token !== (await auth.csrf(session(c) ?? ""))) return c.text("CSRF token mismatch", 403);
    }
    await next();
  });

  app.post("/internal/control", async (c) => c.json(await rt.applyControl((await c.req.json().catch(() => ({}))) as ControlActions)));

  /* ------------------------------------------------ health/auth */

  app.get("/api/health", async (c) => {
    try {
      await ctx.repos.db.query("SELECT 1");
      return c.json({ ok: true, db: ctx.repos.db.kind, running: rt.app.scheduler.running, telegram: !!rt.telegram });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.get("/login", async (c) => c.html(layout("로그인", `<div class="card" style="max-width:420px"><h1>관리자 로그인</h1><form method="post" action="/login"><label>비밀번호</label><input type="password" name="password" autocomplete="current-password" required><button>로그인</button></form></div>`)));
  app.post("/login", async (c) => {
    const f = await form(c);
    const s = await auth.login(str(f.password));
    if (!s) return c.html(layout("로그인", `<div class="card" style="max-width:420px"><h1>관리자 로그인</h1><form method="post" action="/login"><label>비밀번호</label><input type="password" name="password" required><button>로그인</button></form></div>`, { flash: { kind: "err", text: "비밀번호가 올바르지 않습니다." } }), 401);
    setCookie(c, COOKIE, s, { httpOnly: true, sameSite: "Strict", path: "/", secure: c.req.url.startsWith("https") });
    return c.redirect((await currentStep()) === "diagnostics" && (await sys<boolean>("setup.completed")) ? "/" : "/setup");
  });
  app.get("/logout", async (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  /* ------------------------------------------------ setup wizard */

  app.get("/setup", async (c) => {
    const step = await currentStep();
    const doneIdx = STEPS.findIndex((s) => s.key === step);
    const completed = await sys<boolean>("setup.completed");
    const steps = `<div class="steps">${STEPS.map((s, i) => `<span class="${completed || i < doneIdx ? "done" : i === doneIdx ? "cur" : ""}">${s.label}</span>`).join("")}</div>`;
    if (step === "admin") {
      return c.html(
        layout(
          "초기 설정",
          `${steps}<div class="card"><h1>관리자 계정 만들기</h1><p class="muted">서버 로그에 출력된 1회용 설정 토큰(또는 AA_SETUP_TOKEN)을 입력하세요. 토큰은 <code>agent-agency setup-token</code> 으로 다시 만들 수 있습니다.</p>
          <form method="post" action="/setup/admin"><label>설정 토큰</label><input name="token" required autocomplete="off"><label>관리자 비밀번호 (12자 이상)</label><input type="password" name="password" minlength="12" required autocomplete="new-password"><button>관리자 생성</button></form></div>`,
          { flash: takeFlash(c) },
        ),
      );
    }
    const tok = await csrf(c);
    let body: string;
    if (step === "telegram" || c.req.query("edit") === "telegram") {
      const admins = (await sys<number[]>("telegram.admin_ids")) ?? ctx.config.TELEGRAM_ADMIN_USER_IDS;
      const lounge = (await sys<string>("telegram.lounge_chat_id")) ?? ctx.config.TELEGRAM_LOUNGE_CHAT_ID ?? "";
      const hasToken = !!ctx.config.TELEGRAM_BOT_TOKEN || (await ctx.vault.has(SECRET_REFS.telegramToken));
      if (!hasToken) {
        body = `<div class="card"><h2>Telegram ① 봇 토큰</h2>
          <ol class="muted"><li>Telegram에서 <b>@BotFather</b>에게 <code>/newbot</code>을 보내 봇을 만듭니다.</li><li>받은 토큰(<code>123456789:AA...</code>)을 아래에 붙여 넣습니다.</li></ol>
          <form method="post" action="/setup/telegram/token">${tok}<label>봇 토큰</label><input type="password" name="token" required autocomplete="off" placeholder="123456789:AA..."><button>봇 확인</button></form></div>`;
      } else {
        const det = await sys<{ at: string; bot?: string; chats: Array<{ id: string; title: string; isForum: boolean }>; users: Array<{ id: number; name: string; username: string | null }>; error?: string }>("setup.telegram_detect");
        const chats = det?.chats ?? [];
        const users = det?.users ?? [];
        body = `<div class="card"><h2>Telegram ② 그룹과 관리자 찾기</h2>
          <ol class="muted">
            <li>Telegram에서 새 그룹을 만들고 봇${det?.bot ? ` <b>@${esc(det.bot)}</b>` : ""}을 초대합니다.</li>
            <li>그룹 설정에서 <b>주제(Topics)</b>를 켭니다.</li>
            <li>그룹 설정 → 관리자 → 봇을 관리자로 지정하고 <b>주제 관리</b>, <b>메시지 고정</b> 권한을 켭니다.</li>
            <li>그룹에 아무 메시지나 하나 보낸 뒤 아래 <b>찾기</b>를 누릅니다.</li>
          </ol>
          <form method="post" action="/setup/telegram/detect">${tok}<button class="secondary">그룹·사용자 찾기</button></form>
          ${det?.error ? `<p class="s-fail">찾기 실패: ${esc(det.error)}</p>` : ""}
          ${det && !det.error && !chats.length ? `<p class="s-warn">아직 그룹 메시지가 보이지 않습니다. 그룹에 메시지를 하나 보내고 다시 찾아 보세요.</p>` : ""}
          <form method="post" action="/setup/telegram">${tok}
            ${chats.length ? `<label>마스터 라운지 그룹</label>${chats.map((ch, i) => `<label class="inline"><input type="radio" name="lounge" value="${esc(ch.id)}" ${lounge === ch.id || (!lounge && i === 0) ? "checked" : ""}> ${esc(ch.title)} ${ch.isForum ? `<small class="s-ok">주제 켜짐</small>` : `<small class="s-warn">주제(Topics)가 꺼져 있습니다</small>`}</label>`).join("")}` : ""}
            ${users.length ? `<label>봇을 조작할 관리자 (본인)</label>${users.map((u) => `<label class="inline"><input type="checkbox" name="admin_${u.id}" ${admins.includes(u.id) || users.length === 1 ? "checked" : ""}> ${esc(u.name)}${u.username ? ` (@${esc(u.username)})` : ""} <small class="muted">${u.id}</small></label>`).join("")}` : ""}
            <details ${chats.length ? "" : "open"}><summary class="muted">직접 입력하기</summary>
              <label>관리자 Telegram 숫자 사용자 ID (쉼표 구분)</label><input name="admins" value="${esc(admins.join(","))}">
              <label>마스터 라운지 그룹 ID (-100...)</label><input name="lounge_manual" value="${esc(chats.length ? "" : lounge)}" placeholder="-100...">
              <label>봇 토큰 변경 (바꿀 때만)</label><input type="password" name="token" autocomplete="off">
            </details>
            <button>연결 테스트 후 저장</button></form>
          <p class="muted">공개 도메인 없이 Long Polling으로 동작합니다.</p></div>`;
      }
    } else if (step === "executors") {
      await ctx.executors.detectAll();
      const policy = (await primaryUser()) ? await resolveExecutionPolicy(ctx.repos, { userId: (await primaryUser())!.id }) : null;
      const rows = ctx.executors
        .list()
        .map((a) => {
          const s = ctx.executors.getStatus(a.id);
          const u = ctx.executors.usabilityReason(a.id);
          const v = ctx.executors.getVerification(a.id);
          return `<tr><td><b>${esc(a.displayName)}</b><br><small>${esc(a.kind)} · ${esc(s?.version ?? "-")}</small></td><td>${statusCell(u.usable ? "ok" : s?.installed ? "warn" : "unsupported")}<br><small>${esc(u.reason)}</small></td><td><small>${esc(s?.authDetail ?? "")}</small></td><td><small>실행 ${esc(s?.capabilities.run)} · 상태조회 ${esc(s?.capabilities.statusQuery ?? "-")} · 취소 ${esc(s?.capabilities.cancel)} · 재개 ${esc(s?.capabilities.resume)} · 사용량 ${esc(s?.capabilities.usageInfo)}</small>${v ? `<br><small class="s-ok">검증됨 ${esc(v.verifiedAt.slice(0, 16))}: ${esc(v.evidence)}</small>` : ""}${s?.notes.length ? `<br><small>${esc(s.notes.join(" "))}</small>` : ""}</td><td><form method="post" action="/setup/executors/verify">${tok}<input type="hidden" name="adapter" value="${esc(a.id)}"><button class="secondary">검증 실행</button></form></td></tr>`;
        })
        .join("");
      body = `<div class="card"><h2>AI 구독 실행기</h2><p class="muted">공식 구독 인증만 사용합니다. 서버에서 다음 명령으로 로그인한 뒤 "검증 실행"을 누르세요. API 키 로그인은 유료 API로 간주되어 자동 사용하지 않습니다.</p>
        <pre>./aa login claude      # Claude Pro/Max 구독\n./aa login codex       # ChatGPT 플랜\n./aa login gemini      # Google 계정 (선택)</pre>
        <p class="muted">설치 폴더(예: /srv/agent-agency)에서 실행합니다. 직접 실행하려면 <code>docker compose exec -it app claude auth login</code>.</p>
        <div class="tbl"><table><tr><th>실행기</th><th>사용 가능</th><th>인증</th><th>지원 범위</th><th></th></tr>${rows}</table></div>
        <form method="post" action="/setup/codex-env">${tok}<label>Codex Cloud 환경 ID (선택, Codex 웹에서 생성)</label><input name="env" value="${esc(policy?.cloud.codexEnvironmentId ?? "")}" placeholder="env_..."><button class="secondary">저장</button></form>
        <form method="post" action="/setup/executors/confirm">${tok}<button>다음 단계</button></form></div>`;
    } else if (step === "github") {
      body = `<div class="card"><h2>GitHub 연결</h2><p class="muted">개인 계정: Fine-grained PAT을 권장합니다. GitHub App은 개인 계정에 새 저장소를 만들 수 없습니다. 조직: GitHub App을 만들어 필요한 저장소에만 설치하세요. 권한은 두 방식 모두 Contents·Pull requests 읽기/쓰기, Checks·Metadata 읽기, 새 저장소를 만들려면 Administration 쓰기가 필요합니다. 자세한 절차는 docs/INSTALL.md 5.4를 보세요.</p>
        <form method="post" action="/setup/github">${tok}<input type="hidden" name="mode" value="app"><div class="row"><div><label>App ID</label><input name="appId"></div><div><label>Installation ID</label><input name="installationId"></div></div><label>Private key (PEM)</label><textarea name="privateKey" placeholder="-----BEGIN RSA PRIVATE KEY-----"></textarea><label>소유자(조직/사용자)</label><input name="owner" value="${esc((await sys<string>("github.owner")) ?? ctx.config.GITHUB_OWNER ?? "")}"><button>GitHub App 연결</button></form>
        <hr><form method="post" action="/setup/github">${tok}<input type="hidden" name="mode" value="pat"><label>Fine-grained Personal Access Token</label><input type="password" name="token" autocomplete="off"><button class="secondary">PAT 연결</button></form>
        <form method="post" action="/setup/github">${tok}<input type="hidden" name="mode" value="skip"><button class="secondary">나중에 (로컬 저장소만 사용)</button></form></div>`;
    } else if (step === "defaults") {
      const user = (await primaryUser())!;
      const profile = await ctx.repos.users.getProfile(user.id);
      const agents = await ctx.repos.agents.listByOwner(user.id);
      body = `<div class="card"><h2>기본 실행 우선순위 · 조직 세계관 · 초기 에이전트</h2><form method="post" action="/setup/defaults">${tok}
        <label>실행 우선순위</label><select name="priority"><option value="cloud,local_cli">공식 구독 Cloud → 격리된 Local CLI (기본)</option><option value="local_cli">격리된 Local CLI만</option><option value="local_cli,cloud">Local CLI → Cloud</option></select>
        <label class="inline"><input type="checkbox" name="fallback" checked> 실행 불가·한도 소진·인증 만료 시 자동 전환</label>
        <p class="muted">종량제 유료 API는 비활성이며 자동 전환하지 않습니다.</p>
        <label>조직 세계관</label><select name="mode">${allModes().map((m) => `<option value="${m}" ${profile.mode === m ? "selected" : ""}>${modeDef(m).emoji} ${modeDef(m).labelKo} — 사용자 ${modeDef(m).titles.user} / 진행자 ${modeDef(m).titles.moderator} / 에이전트 ${modeDef(m).titles.member}</option>`).join("")}</select>
        ${
          agents.length
            ? `<p>등록된 에이전트: ${agents.map((a) => esc(a.name)).join(", ")}</p>`
            : `<div class="row"><div><label class="inline"><input type="checkbox" name="claude" checked> Claude 에이전트</label><input name="claudeName" value="클로드"><select name="claudePersona">${PERSONAS.map((p) => `<option ${p === "careful" ? "selected" : ""}>${p}</option>`).join("")}</select></div>
               <div><label class="inline"><input type="checkbox" name="codex" checked> Codex 에이전트</label><input name="codexName" value="코덱스"><select name="codexPersona">${PERSONAS.map((p) => `<option ${p === "bold" ? "selected" : ""}>${p}</option>`).join("")}</select></div></div>`
        }
        <button>저장</button></form></div>`;
    } else {
      const checks = await runDiagnostics(ctx, { detect: false });
      const smoke = await sys<{ at: string; results: Array<{ name: string; ok: boolean; detail: string }> }>("setup.smoke");
      body = `<div class="card"><h2>전체 연결 진단</h2><div class="tbl"><table><tr><th>영역</th><th>항목</th><th>상태</th><th>상세</th></tr>${checks.map((x) => `<tr><td>${esc(x.area)}</td><td>${esc(x.name)}</td><td>${statusCell(x.status)}</td><td><small>${esc(x.detail)}</small></td></tr>`).join("")}</table></div></div>
        <div class="card"><h2>엔드투엔드 스모크 테스트</h2><p class="muted">라운지에 테스트 메시지 전송 → 실행기 실제 실행(읽기 전용) → GitHub 인증 확인을 순서대로 수행합니다.</p>
        ${smoke ? `<ul>${smoke.results.map((r) => `<li class="${r.ok ? "s-ok" : "s-fail"}">${r.ok ? "✓" : "✕"} ${esc(r.name)} — <small>${esc(r.detail)}</small></li>`).join("")}</ul><small class="muted">${esc(smoke.at)}</small>` : ""}
        <form method="post" action="/setup/smoke">${tok}<button class="secondary">스모크 테스트 실행</button></form>
        <form method="post" action="/setup/finish">${tok}<button>${(await sys<boolean>("setup.completed")) ? "운영 중 — 대시보드로" : "Telegram 운영 시작"}</button></form></div>`;
    }
    return page(c, "초기 설정", `${steps}<h1>초기 설정</h1>${body}`);
  });

  app.post("/setup/admin", async (c) => {
    const f = await form(c);
    try {
      await auth.createAdmin(str(f.token), str(f.password));
      const s = await auth.issue();
      setCookie(c, COOKIE, s, { httpOnly: true, sameSite: "Strict", path: "/" });
      return c.redirect("/setup");
    } catch (e) {
      return c.html(layout("초기 설정", `<div class="card"><h1>관리자 계정 만들기</h1><form method="post" action="/setup/admin"><label>설정 토큰</label><input name="token" required><label>관리자 비밀번호 (12자 이상)</label><input type="password" name="password" minlength="12" required><button>관리자 생성</button></form></div>`, { flash: { kind: "err", text: (e as Error).message } }), 400);
    }
  });

  app.post("/setup/telegram/token", async (c) => {
    const f = await form(c);
    const r = await setup.saveTelegramToken(str(f.token));
    if (!r.ok) {
      flash(c, "err", `봇 토큰 확인 실패: ${r.detail}`);
      return c.redirect("/setup");
    }
    flash(c, "ok", `@${r.bot} 봇을 확인했습니다. 이제 그룹을 준비하세요.`);
    return c.redirect("/setup?edit=telegram");
  });

  app.post("/setup/telegram/detect", async (c) => {
    const token = await setup.telegramToken();
    // getUpdates only works while nobody else is polling: pause the running bot briefly.
    const wasRunning = !!rt.telegram;
    if (wasRunning) await rt.telegram!.stop().catch(() => undefined);
    const r = await setup.net.detectTelegramChats(token);
    if (wasRunning) await rt.startTelegram().catch(() => undefined);
    await setSys("setup.telegram_detect", { at: new Date().toISOString(), bot: r.bot, chats: r.chats, users: r.users, error: r.ok ? undefined : r.error });
    return c.redirect("/setup?edit=telegram");
  });

  app.post("/setup/telegram", async (c) => {
    const f = await form(c);
    const picked = Object.keys(f)
      .filter((k) => /^admin_\d+$/.test(k) && f[k] === "on")
      .map((k) => Number(k.slice(6)));
    const admins = [
      ...new Set([
        ...picked,
        ...str(f.admins)
          .split(/[,\s]+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0),
      ]),
    ];
    const lounge = str(f.lounge_manual) || str(f.lounge) || null;
    let d;
    try {
      d = await setup.configureTelegram({ admins, lounge, token: str(f.token) || undefined });
    } catch (e) {
      flash(c, "err", (e as Error).message);
      return c.redirect("/setup?edit=telegram");
    }
    await rt.startTelegram().catch((e) => flash(c, "err", `봇 시작 실패: ${(e as Error).message}`));
    const failed = d.checks.filter((x) => !x.ok);
    flash(c, failed.length ? "err" : "ok", failed.length ? `저장했지만 확인 필요: ${failed.map((x) => `${x.name}(${x.detail})`).join(", ")}` : `@${d.bot} 연결 완료`);
    return c.redirect("/setup");
  });

  app.post("/setup/executors/verify", async (c) => {
    const f = await form(c);
    const r = await setup.verify(str(f.adapter));
    flash(c, r.ok ? "ok" : "err", `${str(f.adapter)}: ${r.detail}`);
    return c.redirect(c.req.header("referer")?.includes("/settings") ? "/settings" : "/setup");
  });

  app.post("/setup/codex-env", async (c) => {
    const f = await form(c);
    await setup.setCodexEnvironment(str(f.env));
    flash(c, "ok", "Codex Cloud 환경 ID를 저장했습니다.");
    return c.redirect("/setup");
  });

  app.post("/setup/executors/confirm", async (c) => {
    if (!ctx.executors.usableIds().length) flash(c, "err", "사용 가능한 실행기가 아직 없습니다. 로그인 후 검증하면 작업을 실행할 수 있습니다. (설정은 계속 진행)");
    await setSys("setup.executors_done", true);
    return c.redirect("/setup");
  });

  app.post("/setup/github", async (c) => {
    const f = await form(c);
    const mode = str(f.mode);
    const owner = str(f.owner) || undefined;
    try {
      const who =
        mode === "app"
          ? await setup.connectGitHub({ mode: "app", appId: str(f.appId), installationId: str(f.installationId), privateKey: str(f.privateKey), owner })
          : mode === "pat"
            ? await setup.connectGitHub({ mode: "pat", token: str(f.token), owner })
            : await setup.connectGitHub({ mode: "skip", owner });
      flash(c, "ok", mode === "skip" ? "GitHub 연결을 건너뛰었습니다. 나중에 ./aa config 에서 연결할 수 있습니다." : `GitHub 연결 완료 (${who})`);
    } catch (e) {
      flash(c, "err", `GitHub 연결 실패: ${(e as Error).message.slice(0, 200)}`);
    }
    return c.redirect("/setup");
  });

  app.post("/setup/defaults", async (c) => {
    const f = await form(c);
    if (!(await primaryUser())) return c.redirect("/setup");
    const priority = str(f.priority).split(",").filter((k): k is "cloud" | "local_cli" => k === "cloud" || k === "local_cli");
    const agents = [];
    if (f.claude === "on") agents.push({ name: str(f.claudeName) || "클로드", preset: str(f.claudePersona), provider: "anthropic" as const, adapterId: "claude-cli" });
    if (f.codex === "on") agents.push({ name: str(f.codexName) || "코덱스", preset: str(f.codexPersona), provider: "openai" as const, adapterId: "codex-cli" });
    await setup.saveDefaults({ priority, autoFallback: f.fallback === "on", mode: str(f.mode), agents });
    flash(c, "ok", "기본 설정을 저장했습니다.");
    return c.redirect("/setup");
  });

  app.post("/setup/smoke", async (c) => {
    await setup.smoke(async (user) => {
      if (!rt.telegram) throw new Error("Telegram 미연결");
      return !!(await rt.telegram.postLounge(user.telegramUserId, { header: "⚙️ AgentAgency", text: "스모크 테스트: 연결 확인 메시지입니다." }));
    });
    return c.redirect("/setup");
  });

  app.post("/setup/finish", async (c) => {
    await setup.finish();
    if (rt.telegram) await setup.greet();
    return c.redirect("/");
  });

  /* ------------------------------------------------ dashboard */

  app.get("/", async (c) => {
    if (!(await sys<boolean>("setup.completed"))) return c.redirect("/setup");
    const user = await primaryUser();
    const checks = await runDiagnostics(ctx, { detect: false });
    const projects = user ? (await ctx.repos.projects.listByOwner(user.id, true)).filter((p) => p.workType !== "lounge") : [];
    const pending = user ? await ctx.repos.approvals.listPending(user.id) : [];
    const res = rt.app.scheduler.lastResourceDecision();
    const maint = await rt.app.orchestrator.maintenanceState();
    const lastBackup = await sys<BackupRecord>("backup.last");
    const load = rt.app.orchestrator.runner.executorLoad();
    const usage = user ? await rt.app.orchestrator.usageText(user, 7) : "";
    const body = `<h1>대시보드</h1>
      ${maint?.on ? `<div class="flash err">유지보수 모드 — ${esc(maint.reason)} (${esc(maint.since.slice(0, 16))}부터). 새 작업을 시작하지 않습니다.</div>` : ""}
      <div class="row"><div class="card"><h2>실행 중</h2><p>${rt.app.scheduler.running}개 프로젝트 작업 / 허용 ${res?.allowedConcurrency ?? ctx.config.AA_MAX_CONCURRENT_PROJECTS}</p><small class="muted">${esc(res?.reasons.join(", ") ?? "")}</small></div>
      <div class="card"><h2>승인 대기</h2><p>${pending.length}건</p><small class="muted">Telegram에서 처리하세요.</small></div>
      <div class="card"><h2>Telegram</h2><p>${rt.telegram ? statusCell("ok") : statusCell("fail")}</p></div>
      <div class="card"><h2>최근 백업</h2>${lastBackup ? `<p>${statusCell(lastBackup.verified === false ? "fail" : "ok")} ${esc(lastBackup.at.slice(0, 16))}</p><small class="muted">${esc(lastBackup.verifyDetail ?? "검증 안 함")}</small>` : `<p class="s-warn">아직 없음</p>`}</div>
      <div class="card"><h2>실행기 부하</h2>${Object.entries(load).map(([id, l]) => `<div><small>${esc(id)}: 실행 ${l.running} · 대기 ${l.waiting} / 최대 ${ctx.config.AA_MAX_RUNS_PER_EXECUTOR}</small></div>`).join("") || `<small class="muted">실행 기록 없음</small>`}</div></div>
      <div class="card"><h2>사용량 · 성과 (최근 7일)</h2><pre>${esc(usage)}</pre></div>
      <div class="card"><h2>프로젝트</h2><div class="tbl"><table><tr><th>이름</th><th>상태</th><th>저장소</th><th>우선순위</th></tr>${projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(projectStatusKo(p.status))}</td><td>${esc(p.repoRef ?? "로컬")}</td><td>${p.priority}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">아직 프로젝트가 없습니다.</td></tr>`}</table></div></div>
      <div class="card"><h2>연결 상태</h2><div class="tbl"><table>${checks.map((x) => `<tr><td>${esc(x.area)}</td><td>${esc(x.name)}</td><td>${statusCell(x.status)}</td><td><small>${esc(x.detail)}</small></td></tr>`).join("")}</table></div></div>`;
    return page(c, "대시보드", body);
  });

  app.get("/api/status", async (c) => c.json({ checks: await runDiagnostics(ctx, { detect: false }), running: rt.app.scheduler.running, resources: rt.app.scheduler.lastResourceDecision(), usage: ctx.usage.snapshot() }));

  /* ------------------------------------------------ agents */

  app.get("/agents", async (c) => {
    const user = await primaryUser();
    if (!user) return c.redirect("/setup");
    const tok = await csrf(c);
    const profile = await ctx.repos.users.getProfile(user.id);
    const agents = await ctx.repos.agents.listByOwner(user.id);
    const adapters = ctx.executors.list().filter((a) => a.kind !== "paid_api");
    const rows: string[] = [];
    for (const a of agents) {
      const persona = await ctx.repos.personas.find(a.personaId);
      const models = ctx.executors.get(a.adapterId)?.knownModels ?? ["auto"];
      rows.push(`<tr><td colspan="6"><form method="post" action="/agents/${esc(a.id)}" class="row">${tok}
        <div><label>이름</label><input name="name" value="${esc(a.name)}"></div>
        <div><label>기본 실행기</label><select name="adapter">${adapters.map((x) => `<option value="${esc(x.id)}" ${x.id === a.adapterId ? "selected" : ""}>${esc(x.displayName)}</option>`).join("")}</select></div>
        <div><label>모델</label><select name="model">${models.map((m) => `<option ${m === a.modelPolicy ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>
        <div><label>성격</label><select name="persona">${PERSONAS.map((p) => `<option ${p === persona?.preset ? "selected" : ""}>${p}</option>`).join("")}</select><input name="custom" value="${esc(persona?.customRules ?? "")}" placeholder="추가 지침 (선택)"></div>
        <div><label>유머 최대 (0~1)</label><input name="humor" type="number" min="0" max="1" step="0.1" value="${esc(persona?.toneBounds.humor ?? 1)}"><label class="inline"><input type="checkbox" name="informal" ${persona?.toneBounds.informalAllowed === false ? "" : "checked"}> 관계에 따라 반말 허용</label></div>
        <div><label class="inline"><input type="checkbox" name="enabled" ${a.enabled ? "checked" : ""}> 활성</label><label class="inline"><input type="checkbox" name="moderator" ${profile.moderatorAgentId === a.id ? "checked" : ""}> 진행자 AI</label><small class="muted">${ctx.team.canWork(a) ? "실행 가능" : "실행기 사용 불가"}</small></div>
        <div><button>저장</button></div></form></td></tr>`);
    }
    const body = `<h1>에이전트</h1><p class="muted">에이전트는 모델과 분리된 지속적 정체성입니다. 이름·모델·실행기·성격을 바꿔도 기억·관계·작업 이력은 유지됩니다.</p>
      <div class="card"><div class="tbl"><table>${rows.join("") || `<tr><td class="muted">에이전트가 없습니다.</td></tr>`}</table></div></div>
      <div class="card"><h2>에이전트 추가</h2><form method="post" action="/agents" class="row">${tok}<div><label>이름</label><input name="name" required></div><div><label>실행기</label><select name="adapter">${adapters.map((x) => `<option value="${esc(x.id)}">${esc(x.displayName)}</option>`).join("")}</select></div><div><label>성격</label><select name="persona">${PERSONAS.map((p) => `<option>${p}</option>`).join("")}</select></div><div><button>추가</button></div></form></div>`;
    return page(c, "에이전트", body);
  });

  app.post("/agents", async (c) => {
    const f = await form(c);
    const user = await primaryUser();
    const ad = ctx.executors.get(str(f.adapter));
    if (!user || !ad || !str(f.name)) {
      flash(c, "err", "입력값을 확인하세요.");
      return c.redirect("/agents");
    }
    const persona = await ctx.repos.personas.create((PERSONAS.includes(str(f.persona) as PersonaPreset) ? str(f.persona) : "careful") as PersonaPreset);
    await ctx.repos.agents.create({ ownerId: user.id, name: str(f.name), provider: ad.provider, adapterId: ad.id, modelPolicy: "auto", authMode: "official_subscription", personaId: persona.id, organizationRole: "auto", dialoguePolicy: "relationship_aware", memoryEnabled: true, relationshipHistory: true, enabled: true });
    flash(c, "ok", `${str(f.name)} 추가됨`);
    return c.redirect("/agents");
  });

  app.post("/agents/:id", async (c) => {
    const f = await form(c);
    const user = await primaryUser();
    const agent = await ctx.repos.agents.find(c.req.param("id"));
    if (!user || !agent || agent.ownerId !== user.id) return c.text("not found", 404);
    const ad = ctx.executors.get(str(f.adapter));
    const model = ad ? ctx.executors.resolveModel(ad.id, str(f.model) || "auto") : "auto";
    await ctx.repos.agents.update(agent.id, { name: str(f.name) || agent.name, adapterId: ad?.id ?? agent.adapterId, provider: ad?.provider ?? agent.provider, modelPolicy: model, enabled: f.enabled === "on" });
    const preset = (PERSONAS.includes(str(f.persona) as PersonaPreset) ? str(f.persona) : "careful") as PersonaPreset;
    const humor = Math.min(1, Math.max(0, Number(str(f.humor) || "1")));
    const toneBounds = { humor: Number.isFinite(humor) ? humor : 1, informalAllowed: f.informal === "on" };
    if (agent.personaId) await ctx.repos.personas.update(agent.personaId, { preset, customRules: str(f.custom) || null, toneBounds });
    if (f.moderator === "on") await ctx.repos.users.updateProfile(user.id, { moderatorAgentId: agent.id });
    await ctx.repos.audit.record("web", "agent.update", `agent:${agent.id}`, "success", { model, adapter: ad?.id });
    flash(c, "ok", "저장했습니다. 정체성·기억은 유지됩니다.");
    return c.redirect("/agents");
  });

  /* ------------------------------------------------ settings */

  app.get("/settings", async (c) => {
    const user = await primaryUser();
    if (!user) return c.redirect("/setup");
    const tok = await csrf(c);
    const profile = await ctx.repos.users.getProfile(user.id);
    const policy = await resolveExecutionPolicy(ctx.repos, { userId: user.id });
    const flags = await ctx.flags.all(user.id);
    const ret = await retentionPolicy(ctx);
    const remote = await sys<{ endpoint: string; region: string; bucket: string; prefix?: string }>("backup.remote");
    const body = `<h1>설정</h1>
      <div class="card"><h2>조직 세계관</h2><form method="post" action="/settings/mode">${tok}<select name="mode">${allModes().map((m) => `<option value="${m}" ${profile.mode === m ? "selected" : ""}>${modeDef(m).emoji} ${modeDef(m).labelKo}</option>`).join("")}</select><button>변경</button></form><small class="muted">표현 레이어만 바뀌며 품질·보안·승인·권한·비용 정책은 동일합니다.</small></div>
      <div class="card"><h2>사용자 정의 세계관</h2>
        ${customModes().map((m) => `<div class="inline"><span>${esc(m.emoji)} <b>${esc(m.labelKo)}</b> <small class="muted">${esc(m.mode)} · 기반 ${esc(modeDef(m.baseMode).labelKo)} · ${esc(m.titles.user)}/${esc(m.titles.moderator)}/${esc(m.titles.member)}</small></span><form method="post" action="/settings/custom-mode/delete">${tok}<input type="hidden" name="slug" value="${esc(m.mode.replace("custom:", ""))}"><button class="secondary">삭제</button></form></div>`).join("") || `<p class="muted">아직 없습니다.</p>`}
        <form method="post" action="/settings/custom-mode" class="row">${tok}
          <div><label>ID (영문)</label><input name="slug" placeholder="startup" required></div>
          <div><label>이름</label><input name="labelKo" placeholder="스타트업" required></div>
          <div><label>이모지</label><input name="emoji" value="🚀" required></div>
          <div><label>기반 세계관 (말투 기본값)</label><select name="baseMode">${ALL_MODES.map((m) => `<option value="${m}">${modeDef(m).labelKo}</option>`).join("")}</select></div>
          <div><label>사용자 호칭</label><input name="user" placeholder="대표" required></div>
          <div><label>진행자 호칭</label><input name="moderator" placeholder="PM" required></div>
          <div><label>에이전트 호칭</label><input name="member" placeholder="메이커" required></div>
          <div><label>팀 전체 호칭</label><input name="teamAddress" placeholder="다들" required></div>
          <div><label>분위기</label><input name="atmosphere" placeholder="빠르게 실험하고 솔직하게 말하는 초기 스타트업" required></div>
          <div><label>에이전트끼리 말투</label><select name="mm"><option value="">기반 따름</option><option value="polite">존댓말</option><option value="casual">친해지면 반말</option></select></div>
          <div><label>에이전트 → 사용자 말투</label><select name="mu"><option value="">기반 따름</option><option value="formal">격식 존댓말</option><option value="polite">편한 존댓말</option></select></div>
          <div><button>저장</button></div></form>
        <small class="muted">말투와 호칭만 바뀝니다. 사실을 꾸며내지 않기, 모욕 금지 같은 기본 규칙과 승인·품질·권한 정책은 그대로 적용됩니다.</small></div>
      <div class="card"><h2>실행 정책</h2><pre>${esc(describePolicy(policy))}</pre><form method="post" action="/settings/exec">${tok}<select name="priority"><option value="cloud,local_cli" ${policy.priority.join(",") === "cloud,local_cli" ? "selected" : ""}>Cloud → Local CLI</option><option value="local_cli" ${policy.priority.join(",") === "local_cli" ? "selected" : ""}>Local CLI만</option><option value="local_cli,cloud" ${policy.priority.join(",") === "local_cli,cloud" ? "selected" : ""}>Local CLI → Cloud</option></select><label class="inline"><input type="checkbox" name="fallback" ${policy.autoFallback ? "checked" : ""}> 자동 전환</label><button>저장</button></form>
        <p class="muted">프로젝트·에이전트별 재정의는 Telegram 프로젝트 Topic의 /exec 명령으로 설정합니다.</p>
        <form method="post" action="/settings/paid-api">${tok}<label class="inline"><input type="checkbox" name="enabled" ${flags["executors.paid_api"] ? "checked" : ""}> 종량제 유료 API 사용 허용</label><small class="s-warn">허용해도 자동 전환하지 않으며, 사용할 때마다 Telegram에서 재확인 승인이 필요합니다. 비용이 발생합니다.</small><br><button class="danger">변경</button></form></div>
      <div class="card"><h2>기능 플래그</h2><form method="post" action="/settings/flags">${tok}${Object.keys(FLAG_DEFAULTS)
        .filter((k) => k !== "executors.paid_api")
        .map((k) => `<label class="inline"><input type="checkbox" name="${esc(k)}" ${flags[k] ? "checked" : ""}> ${esc(k)}</label>`)
        .join("")}<button>저장</button></form></div>
      <div class="card"><h2>데이터 보존</h2><form method="post" action="/settings/retention" class="row">${tok}<div><label>실행 로그·스크린샷 (일)</label><input name="logDays" type="number" min="1" value="${ret.logDays}"></div><div><label>임시 파일 (일)</label><input name="tmpDays" type="number" min="1" value="${ret.tmpDays}"></div><div><button>저장</button></div></form><small class="muted">진행·차단·승인 대기 중인 작업의 증거는 정리에서 제외됩니다.</small></div>
      <div class="card"><h2>인증정보 유출 대응</h2><p class="muted">유출이 의심되면 즉시 차단하세요. 로컬에서 바로 사용을 막고, 공식 폐기 API가 있는 발급처(GitHub 토큰)는 폐기 요청 결과를 확인합니다. 없는 경우 폐기 방법을 안내합니다.</p>
        <div class="tbl"><table><tr><th>이름</th><th>상태</th><th>등록</th><th></th></tr>${(await ctx.vault.list(SYSTEM_OWNER)).map((x) => `<tr><td>${esc(x.label)}</td><td>${x.revoked ? `<span class="s-fail">차단됨</span>` : `<span class="s-ok">사용 중</span>`}</td><td><small>${esc(x.createdAt.slice(0, 10))}</small></td><td>${x.revoked ? "" : `<form method="post" action="/settings/revoke">${tok}<input type="hidden" name="ref" value="${esc(x.ref)}"><button class="danger">즉시 차단</button></form>`}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">저장된 인증정보 없음</td></tr>`}</table></div></div>
      <div class="card"><h2>원격 백업 (S3 호환, 선택)</h2><form method="post" action="/settings/backup-remote" class="row">${tok}<div><label>Endpoint</label><input name="endpoint" value="${esc(remote?.endpoint ?? "")}" placeholder="https://s3.<region>.amazonaws.com"></div><div><label>Region</label><input name="region" value="${esc(remote?.region ?? "")}"></div><div><label>Bucket</label><input name="bucket" value="${esc(remote?.bucket ?? "")}"></div><div><label>Prefix</label><input name="prefix" value="${esc(remote?.prefix ?? "agent-agency")}"></div><div><label>Access key</label><input name="access" type="password" autocomplete="off"></div><div><label>Secret key</label><input name="secret" type="password" autocomplete="off"></div><div><button>저장</button></div></form><small class="muted">AWS S3, OCI Object Storage(S3 호환), R2, MinIO 등 어떤 제공업체든 사용할 수 있습니다. 원격 백업은 AA_BACKUP_PASSPHRASE 암호화가 필수입니다.</small></div>`;
    return page(c, "설정", body);
  });

  app.post("/settings/mode", async (c) => {
    const f = await form(c);
    const user = await primaryUser();
    if (user && isOrganizationMode(str(f.mode))) await rt.app.orchestrator.setMode(user, str(f.mode) as any);
    flash(c, "ok", "세계관을 변경했습니다.");
    return c.redirect("/settings");
  });

  app.post("/settings/custom-mode", async (c) => {
    const f = await form(c);
    const overrides: Record<string, string> = {};
    if (str(f.mm)) overrides["member>member"] = str(f.mm);
    if (str(f.mu)) overrides["member>user"] = str(f.mu);
    try {
      const def = await saveCustomMode(ctx.repos, {
        slug: str(f.slug),
        labelKo: str(f.labelKo),
        emoji: str(f.emoji),
        atmosphere: str(f.atmosphere),
        baseMode: str(f.baseMode),
        titles: { user: str(f.user), moderator: str(f.moderator), member: str(f.member) },
        teamAddress: str(f.teamAddress),
        registerOverrides: Object.keys(overrides).length ? overrides : undefined,
      });
      await ctx.repos.audit.record("web", "custom_mode.save", `mode:${def.mode}`, "success");
      flash(c, "ok", `${def.labelKo} 세계관을 저장했습니다. Telegram에서 /mode ${def.mode} 로 바꿀 수 있습니다.`);
    } catch (e) {
      const msg = e instanceof Error && "issues" in e ? (e as any).issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join(", ") : (e as Error).message;
      flash(c, "err", `저장 실패: ${msg}`);
    }
    return c.redirect("/settings");
  });

  app.post("/settings/custom-mode/delete", async (c) => {
    const f = await form(c);
    const n = await deleteCustomMode(ctx.repos, str(f.slug));
    await ctx.repos.audit.record("web", "custom_mode.delete", `mode:custom:${str(f.slug)}`, "success", { reverted: n });
    flash(c, "ok", `삭제했습니다.${n ? ` 이 세계관을 쓰던 사용자 ${n}명은 기반 세계관으로 돌아갑니다.` : ""}`);
    return c.redirect("/settings");
  });

  app.post("/settings/exec", async (c) => {
    const f = await form(c);
    const user = await primaryUser();
    const priority = str(f.priority).split(",").filter((k): k is "cloud" | "local_cli" => k === "cloud" || k === "local_cli");
    if (user) await setExecutionPolicy(ctx.repos, "user", user.id, { priority, autoFallback: f.fallback === "on" });
    flash(c, "ok", "실행 정책을 저장했습니다.");
    return c.redirect("/settings");
  });

  app.post("/settings/paid-api", async (c) => {
    const f = await form(c);
    const enabled = f.enabled === "on";
    await ctx.flags.set("executors.paid_api", enabled);
    const user = await primaryUser();
    if (user) await setExecutionPolicy(ctx.repos, "user", user.id, { paidApi: { enabled } });
    await ctx.repos.audit.record("web", "paid_api.toggle", "execution", "success", { enabled });
    flash(c, "ok", enabled ? "유료 API 사용을 허용했습니다. 사용할 때마다 별도 승인이 필요합니다." : "유료 API를 비활성화했습니다.");
    return c.redirect("/settings");
  });

  app.post("/settings/flags", async (c) => {
    const f = await form(c);
    for (const k of Object.keys(FLAG_DEFAULTS)) {
      if (k === "executors.paid_api") continue;
      await ctx.flags.set(k, f[k] === "on");
    }
    await syncExecutorFlags(ctx);
    await ctx.repos.audit.record("web", "flags.update", "flags", "success");
    flash(c, "ok", "기능 플래그를 저장했습니다.");
    return c.redirect("/settings");
  });

  app.post("/settings/retention", async (c) => {
    const f = await form(c);
    const logDays = Math.max(1, Number(str(f.logDays)) || 30);
    const tmpDays = Math.max(1, Number(str(f.tmpDays)) || 7);
    await setSys("retention", { logDays, tmpDays });
    flash(c, "ok", "보존 기간을 저장했습니다.");
    return c.redirect("/settings");
  });

  app.post("/settings/revoke", async (c) => {
    const f = await form(c);
    const r = await revokeCredential(ctx, str(f.ref));
    if (r.ref === SECRET_REFS.telegramToken && rt.telegram) await rt.telegram.stop().catch(() => undefined);
    if (r.ref === SECRET_REFS.githubToken || r.ref === SECRET_REFS.githubAppKey) await rt.app.reloadGitHub();
    flash(c, r.official === "failed" ? "err" : "ok", `로컬 차단 완료. ${r.detail}`);
    return c.redirect("/settings");
  });

  app.post("/settings/backup-remote", async (c) => {
    const f = await form(c);
    await setSys("backup.remote", { endpoint: str(f.endpoint), region: str(f.region), bucket: str(f.bucket), prefix: str(f.prefix) || undefined });
    if (str(f.access)) await ctx.vault.put(SYSTEM_OWNER, "Backup S3 access key", str(f.access), null, SECRET_REFS.s3Access);
    if (str(f.secret)) await ctx.vault.put(SYSTEM_OWNER, "Backup S3 secret key", str(f.secret), null, SECRET_REFS.s3Secret);
    flash(c, "ok", "원격 백업 설정을 저장했습니다. 기능 플래그 backup.remote를 켜면 정기 백업 시 업로드합니다.");
    return c.redirect("/settings");
  });

  /* ------------------------------------------------ backups */

  app.get("/backups", async (c) => {
    const tok = await csrf(c);
    const list = listBackups(ctx.config.backupsDir);
    const last = await sys<BackupRecord>("backup.last");
    const body = `<h1>백업 · 복원</h1><div class="card">${last ? `<p>최근 백업 ${esc(last.file)} — ${last.verified === false ? `<span class="s-fail">복원 검증 실패: ${esc(last.verifyDetail)}</span>` : last.verified ? `<span class="s-ok">복원 검증 통과 (${esc(last.verifyDetail)})</span>` : "검증 안 함"}</p>` : ""}<form method="post" action="/backups/create">${tok}<button>지금 백업 (복원 검증 포함)</button></form><p class="muted">로컬 정기 백업이 매일 실행됩니다. 마스터 키(data/master.key 또는 AA_MASTER_KEY)는 백업에 포함되지 않으니 별도로 보관하세요.</p>
      <div class="tbl"><table><tr><th>파일</th><th>크기</th><th>생성</th><th></th></tr>${list.map((b) => `<tr><td>${esc(b.name)}</td><td>${(b.bytes / 1024).toFixed(1)}KB</td><td>${esc(b.createdAt.slice(0, 16))}</td><td><a href="/backups/download/${encodeURIComponent(b.name)}">다운로드</a></td></tr>`).join("") || `<tr><td colspan="4" class="muted">백업 없음</td></tr>`}</table></div></div>
      <div class="card"><h2>복원</h2><p class="s-warn">현재 데이터를 백업 내용으로 교체합니다. 복원 직전에 자동 백업을 하나 만듭니다.</p><form method="post" action="/backups/restore" enctype="multipart/form-data">${tok}<input type="file" name="file" required><label>확인을 위해 RESTORE 입력</label><input name="confirm" required><button class="danger">복원</button></form></div>`;
    return page(c, "백업", body);
  });

  app.post("/backups/create", async (c) => {
    try {
      const r = await runBackup(ctx);
      flash(c, r.verification && !r.verification.ok ? "err" : "ok", `백업 완료: ${path.basename(r.file)}${r.remote ? ` (원격: ${r.remote})` : ""} — ${r.verification ? (r.verification.ok ? `복원 검증 통과 ${r.verification.rows}행` : `복원 검증 실패: ${r.verification.reason}`) : "검증 안 함"}`);
    } catch (e) {
      flash(c, "err", `백업 실패: ${(e as Error).message}`);
    }
    return c.redirect("/backups");
  });

  app.get("/backups/download/:name", async (c) => {
    const name = path.basename(c.req.param("name"));
    const file = path.join(ctx.config.backupsDir, name);
    if (!name.startsWith("aa-backup-") || !fs.existsSync(file)) return c.text("not found", 404);
    await ctx.repos.audit.record("web", "backup.download", "backup", "success", { name });
    return new Response(fs.readFileSync(file), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` } });
  });

  app.post("/backups/restore", async (c) => {
    const f = await form(c);
    const file = f.file;
    if (str(f.confirm) !== "RESTORE" || !(file instanceof File)) {
      flash(c, "err", "확인 문구 또는 파일이 올바르지 않습니다.");
      return c.redirect("/backups");
    }
    try {
      await runBackup(ctx, { remote: false });
      const tmp = path.join(ctx.config.backupsDir, `upload-${Date.now()}.bin`);
      fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
      const r = await restoreFromFile(ctx.repos.db, tmp, process.env.AA_BACKUP_PASSPHRASE || undefined);
      fs.rmSync(tmp, { force: true });
      await ctx.repos.audit.record("web", "backup.restore", "backup", "success", r);
      flash(c, "ok", `복원 완료: ${r.rows}개 행 (스키마 v${r.schemaVersion}). 서비스를 재시작하세요.`);
    } catch (e) {
      flash(c, "err", `복원 실패: ${(e as Error).message}`);
    }
    return c.redirect("/backups");
  });

  /* ------------------------------------------------ audit */

  app.get("/audit", async (c) => {
    const events = await ctx.repos.audit.list(200);
    const body = `<h1>감사 로그</h1><div class="card tbl"><table><tr><th>시각</th><th>주체</th><th>행위</th><th>대상</th><th>결과</th><th>상세(마스킹)</th></tr>${events.map((e) => `<tr><td><small>${esc(e.createdAt.slice(0, 19))}</small></td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td><small>${esc(e.resource)}</small></td><td>${esc(e.outcome)}</td><td><small>${esc(JSON.stringify(e.maskedDetails).slice(0, 300))}</small></td></tr>`).join("")}</table></div>`;
    return page(c, "감사 로그", body);
  });

  return app;
}
