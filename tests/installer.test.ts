import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpDir } from "./helpers.js";
import { width } from "../src/cli/term.js";

const ROOT = path.resolve(__dirname, "..");
const canChown = process.getuid?.() === 0 || spawnSync("sudo", ["-n", "true"]).status === 0;

/** A minimal checkout: what install.sh needs before Docker. */
function fakeRepo(): string {
  const src = tmpDir("aa-src-");
  for (const f of ["install.sh", "aa", ".env.example", "docker-compose.yml", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(src, f));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: src, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "init");
  return src;
}

const run = (args: string[], env: Record<string, string> = {}, cwd = ROOT) =>
  spawnSync("bash", args, { cwd, env: { ...process.env, NO_COLOR: "1", AA_GITHUB_TOKEN: "", ...env }, encoding: "utf8", timeout: 60_000 });

describe("install.sh (one command from a bare server)", () => {
  it.skipIf(!canChown)("standalone: clones into the chosen folder, continues there and writes .env once", () => {
    const repo = fakeRepo();
    const alone = tmpDir("aa-alone-");
    fs.copyFileSync(path.join(ROOT, "install.sh"), path.join(alone, "install.sh"));
    const dir = path.join(tmpDir("aa-target-"), "agent-agency");
    const r = run([path.join(alone, "install.sh"), "-y", "--no-start", "--dir", dir], { AA_REPO_URL: repo });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("코드 받기");
    expect(r.stdout).toContain(".env 생성");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{48}$/m);
    expect(env).toMatch(/^AA_BACKUP_PASSPHRASE=[0-9a-f]{48}$/m);
    expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
    // Running again (from the checkout) keeps the secrets.
    const again = run([path.join(dir, "install.sh"), "-y", "--no-start"]);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain("기존 .env 그대로 사용");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
  });

  it("refuses a non-empty folder that is not a checkout", () => {
    const alone = tmpDir("aa-alone-");
    fs.copyFileSync(path.join(ROOT, "install.sh"), path.join(alone, "install.sh"));
    const dir = tmpDir("aa-busy-");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    const r = run([path.join(alone, "install.sh"), "-y", "--no-start", "--dir", dir], { AA_REPO_URL: "/nonexistent" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("비어 있지 않아요");
  });

  it("aa shares the installer's terminal UI and draws aligned boxes with Korean text", () => {
    const out = execFileSync("bash", ["-c", `source <(sed -n '/^# >>> tui/,/^# <<< tui/p' install.sh); tui_box "한글 제목" "abc"; tui_ok "완료"`], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" });
    const box = out.split("\n").slice(0, 4);
    expect(new Set(box.map((l) => width(l))).size).toBe(1);
    expect(out).toContain("⎿  ✓ 완료");
  });

  it("both scripts parse", () => {
    for (const f of ["install.sh", "aa"]) expect(spawnSync("bash", ["-n", f], { cwd: ROOT }).status).toBe(0);
  });
});
