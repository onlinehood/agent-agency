import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.js";
import { diagnoseLogin, killStrayGemini, pinOAuth, savedAuthType } from "../src/executors/geminiLogin.js";

describe("gemini login helpers", () => {
  it("pins Login with Google and keeps other settings", () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ selectedAuthType: "gemini-api-key", security: { auth: { selectedType: "gemini-api-key" }, folderTrust: { enabled: true } }, ui: { theme: "dark" } }));
    pinOAuth(home);
    const j = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    expect(j.security.auth.selectedType).toBe("oauth-personal");
    expect(j.selectedAuthType).toBeUndefined();
    expect(j.security.folderTrust).toEqual({ enabled: true });
    expect(j.ui).toEqual({ theme: "dark" });
    // Unreadable settings are backed up, not lost.
    fs.writeFileSync(path.join(home, "settings.json"), "{ broken");
    pinOAuth(home);
    expect(fs.readFileSync(path.join(home, "settings.json.bak"), "utf8")).toBe("{ broken");
    expect(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).security.auth.selectedType).toBe("oauth-personal");
  });

  it("closes other gemini processes but never itself or its parents", () => {
    const proc = tmpDir();
    const add = (pid: number, ppid: number, argv: string[]) => {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
      fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (node) S ${ppid} 1 1`);
    };
    add(1, 0, ["node", "/app/dist/cli.js", "start"]);
    add(40, 1, ["node", "/usr/local/bin/gemini"]); // left over from an earlier login
    add(41, 40, ["node", "/usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js"]); // relaunched child
    add(50, 1, ["sh", "-c", "agent-agency gemini-login"]);
    add(51, 50, ["node", "/usr/local/bin/agent-agency", "gemini-login"]); // this process
    add(60, 1, ["node", "/usr/local/bin/claude"]);
    const signalled: number[] = [];
    expect(killStrayGemini({ procRoot: proc, selfPid: 51, kill: (p) => signalled.push(p) }).sort()).toEqual([40, 41]);
    expect(signalled.sort()).toEqual([40, 41]);
  });

  it("reports saved credentials, or the reason Gemini logged and what to do", () => {
    const home = tmpDir();
    const log = path.join(home, "login.log");
    fs.writeFileSync(log, ["[DEBUG] Failed to load credentials: ENOENT", "[ERROR] Error authenticating: IneligibleTierError: reason DASHER_USER", "[INFO] started"].join("\n"));
    const d = diagnoseLogin(home, log);
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("DASHER_USER");
    expect(d.reason).not.toContain("ENOENT");
    expect(d.hint).toContain("개인 Gmail");
    expect(diagnoseLogin(home, path.join(home, "missing.log")).hint).toContain("Enter는 한 번만");
    // No reason logged, but Gemini switched itself to the API key: say Google refused the account.
    expect(diagnoseLogin(home, path.join(home, "missing.log"), true).hint).toContain("무료 Gemini CLI(Code Assist)를 열어 주지 않았다");
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    expect(savedAuthType(home)).toBe("gemini-api-key");
    fs.writeFileSync(path.join(home, "oauth_creds.json"), "{}");
    expect(diagnoseLogin(home, log)).toEqual({ ok: true });
  });
});
