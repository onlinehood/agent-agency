import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { maskSecrets, maskKnown } from "../src/security/masking.js";
import { Vault, encrypt, decrypt } from "../src/security/vault.js";
import { openAndMigrate } from "../src/db/index.js";
import { minimalEnv, PAID_API_ENV_VARS } from "../src/executors/process.js";

describe("secret masking", () => {
  it("masks common token formats", () => {
    const s = maskSecrets("tg 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw gh ghp_abcdefghijklmnopqrstuvwxyz0123 key sk-ant-api03-abcdefghijklmnopqrstuv GITHUB_TOKEN=supersecretvalue Bearer abcdefghijklmnop1234");
    expect(s).not.toMatch(/AAHdqTcv|ghp_abc|sk-ant-api03|supersecretvalue|abcdefghijklmnop1234/);
    expect(maskKnown("my value hunter22hunter", ["hunter22hunter"])).toBe("my value [REDACTED]");
  });

  it("child CLI env never contains paid API keys", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "y";
    const env = minimalEnv({ ANTHROPIC_API_KEY: "z" });
    for (const k of PAID_API_ENV_VARS) expect(env[k]).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});

describe("vault", () => {
  it("encrypts with AES-GCM and enforces owner/project scope and revocation", async () => {
    const key = randomBytes(32);
    const blob = encrypt(key, "hello", "aad");
    expect(decrypt(key, blob, "aad")).toBe("hello");
    expect(() => decrypt(key, blob, "other")).toThrow();
    const db = await openAndMigrate({});
    await db.query("INSERT INTO users(id, telegram_user_id) VALUES ('u1', 1), ('u2', 2)");
    const v = new Vault(db, key);
    const ref = await v.put("u1", "token", "s3cr3t-value", "p1");
    const raw = await db.query<{ ciphertext: string }>("SELECT ciphertext FROM secrets");
    expect(raw[0]!.ciphertext).not.toContain("s3cr3t");
    expect(await v.get(ref, { ownerId: "u1", projectId: "p1" })).toBe("s3cr3t-value");
    await expect(v.get(ref, { ownerId: "u2", projectId: "p1" })).rejects.toThrow();
    await expect(v.get(ref, { ownerId: "u1", projectId: "p2" })).rejects.toThrow();
    expect(await v.allValuesForMasking("u1")).toContain("s3cr3t-value");
    await v.revoke(ref);
    await expect(v.get(ref, { ownerId: "u1", projectId: "p1" })).rejects.toThrow(/revoked/);
    expect(await v.allValuesForMasking("u1")).not.toContain("s3cr3t-value");
    await db.close();
  });
});
