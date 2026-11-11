import fs from "node:fs";
import path from "node:path";
import type { ProjectSettings } from "../core/types.js";

export interface CheckCommand {
  name: "install" | "lint" | "typecheck" | "test" | "security" | "playwright" | "build";
  cmd: string;
  args: string[];
  /** Whether a failure blocks the gate */
  blocking: boolean;
  timeoutMs: number;
}

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function splitCmd(s: string): { cmd: string; args: string[] } {
  // minimal shell-free splitter supporting quoted segments
  const parts = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const clean = parts.map((p) => p.replace(/^["']|["']$/g, ""));
  return { cmd: clean[0] ?? "true", args: clean.slice(1) };
}

/**
 * Detect quality gate commands from the workspace. Explicit project settings win.
 */
export function detectChecks(dir: string, settings: ProjectSettings = {}, opts: { playwright?: boolean; security?: boolean } = {}): CheckCommand[] {
  const checks: CheckCommand[] = [];
  const pkg = readJson(path.join(dir, "package.json"));
  const has = (f: string) => fs.existsSync(path.join(dir, f));

  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  const runScript = (script: string) => (pm === "npm" ? { cmd: "npm", args: ["run", script, "--silent"] } : { cmd: pm, args: [script] });

  if (pkg) {
    const scripts = pkg.scripts ?? {};
    const hasDeps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0;
    if (hasDeps && !has("node_modules")) {
      checks.push({ name: "install", ...(pm === "npm" ? { cmd: "npm", args: has("package-lock.json") ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"] } : { cmd: pm, args: ["install", "--frozen-lockfile"] }), blocking: true, timeoutMs: 15 * 60_000 });
    }
    if (settings.lintCommand) checks.push({ name: "lint", ...splitCmd(settings.lintCommand), blocking: true, timeoutMs: 10 * 60_000 });
    else if (scripts.lint) checks.push({ name: "lint", ...runScript("lint"), blocking: true, timeoutMs: 10 * 60_000 });
    if (settings.typecheckCommand) checks.push({ name: "typecheck", ...splitCmd(settings.typecheckCommand), blocking: true, timeoutMs: 10 * 60_000 });
    else if (scripts.typecheck) checks.push({ name: "typecheck", ...runScript("typecheck"), blocking: true, timeoutMs: 10 * 60_000 });
    else if (has("tsconfig.json")) checks.push({ name: "typecheck", cmd: "npx", args: ["--no-install", "tsc", "--noEmit"], blocking: true, timeoutMs: 10 * 60_000 });
    if (settings.testCommand) checks.push({ name: "test", ...splitCmd(settings.testCommand), blocking: true, timeoutMs: 20 * 60_000 });
    else if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ name: "test", ...runScript("test"), blocking: true, timeoutMs: 20 * 60_000 });
    if (opts.security) checks.push({ name: "security", cmd: "npm", args: ["audit", "--audit-level=high", "--omit=dev"], blocking: false, timeoutMs: 5 * 60_000 });
    const hasPw = has("playwright.config.ts") || has("playwright.config.js") || has("playwright.config.mjs");
    if (opts.playwright && (settings.playwrightCommand || hasPw)) {
      checks.push({ name: "playwright", ...(settings.playwrightCommand ? splitCmd(settings.playwrightCommand) : { cmd: "npx", args: ["--no-install", "playwright", "test", "--trace", "off", "--reporter=line"] }), blocking: true, timeoutMs: 20 * 60_000 });
    }
    return checks;
  }

  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    if (settings.lintCommand) checks.push({ name: "lint", ...splitCmd(settings.lintCommand), blocking: true, timeoutMs: 10 * 60_000 });
    else if (has("pyproject.toml") && /ruff/.test(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8"))) checks.push({ name: "lint", cmd: "ruff", args: ["check", "."], blocking: true, timeoutMs: 5 * 60_000 });
    if (settings.typecheckCommand) checks.push({ name: "typecheck", ...splitCmd(settings.typecheckCommand), blocking: true, timeoutMs: 10 * 60_000 });
    checks.push({ name: "test", ...(settings.testCommand ? splitCmd(settings.testCommand) : { cmd: "python", args: ["-m", "pytest", "-q"] }), blocking: true, timeoutMs: 20 * 60_000 });
    if (opts.security) checks.push({ name: "security", cmd: "pip-audit", args: [], blocking: false, timeoutMs: 5 * 60_000 });
    return checks;
  }

  if (has("go.mod")) {
    checks.push({ name: "lint", cmd: "go", args: ["vet", "./..."], blocking: true, timeoutMs: 10 * 60_000 });
    checks.push({ name: "test", cmd: "go", args: ["test", "./..."], blocking: true, timeoutMs: 20 * 60_000 });
    return checks;
  }

  if (has("Cargo.toml")) {
    checks.push({ name: "lint", cmd: "cargo", args: ["clippy", "--", "-D", "warnings"], blocking: true, timeoutMs: 15 * 60_000 });
    checks.push({ name: "test", cmd: "cargo", args: ["test"], blocking: true, timeoutMs: 20 * 60_000 });
    return checks;
  }

  if (settings.testCommand) checks.push({ name: "test", ...splitCmd(settings.testCommand), blocking: true, timeoutMs: 20 * 60_000 });
  return checks;
}
