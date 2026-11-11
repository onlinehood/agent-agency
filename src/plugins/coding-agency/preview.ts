import type { FileStore } from "../../storage/fileStore.js";

/**
 * Preview URL + screenshot helper (PRD §5-8). Preview deployment itself is provider-specific,
 * so it is configured as a URL template on the project (e.g. a Vercel/Netlify/Pages preview
 * pattern) and only used when the `coding.preview_deploy` flag is on. Screenshots use the
 * Playwright installation on the server if present; otherwise they are skipped honestly.
 */
export function previewUrlFor(template: string | undefined, vars: { branch: string; pr?: number | null; slug: string }): string | null {
  if (!template) return null;
  const branchSlug = vars.branch.replace(/[^A-Za-z0-9-]/g, "-").toLowerCase();
  return template
    .replace(/\{branch\}/g, branchSlug)
    .replace(/\{pr\}/g, vars.pr != null ? String(vars.pr) : "")
    .replace(/\{slug\}/g, vars.slug);
}

export async function captureScreenshot(url: string, files: FileStore, name: string): Promise<{ ref: string | null; note: string }> {
  let pw: any;
  try {
    const mod = "playwright";
    pw = await import(mod);
  } catch {
    return { ref: null, note: "Playwright가 서버에 설치되어 있지 않아 스크린샷을 생략했습니다." };
  }
  const browser = await pw.chromium.launch({ args: ["--no-sandbox"] }).catch((e: Error) => {
    throw new Error(`브라우저 실행 실패: ${e.message}`);
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const buf: Buffer = await page.screenshot({ fullPage: false });
    const stored = await files.put("screenshots", `${name}.png`, buf);
    return { ref: stored.ref, note: "스크린샷 저장됨" };
  } catch (e) {
    return { ref: null, note: `스크린샷 실패: ${(e as Error).message}` };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
