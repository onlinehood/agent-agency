import { createHash, createHmac } from "node:crypto";

/**
 * Minimal S3-compatible upload (AWS SigV4, path-style). Works with OCI Object Storage's S3
 * compatibility API, AWS S3, Cloudflare R2, MinIO, Backblaze B2, etc. — no provider SDK, so the
 * core never depends on a specific cloud (PRD §16). Optional, behind `backup.remote`.
 */
export interface S3Target {
  endpoint: string; // e.g. https://s3.us-east-1.amazonaws.com or https://<ns>.compat.objectstorage.<region>.oraclecloud.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

export function signS3Put(t: S3Target, key: string, body: Buffer, now = new Date()): { url: string; headers: Record<string, string> } {
  const url = new URL(t.endpoint);
  const objectPath = `/${t.bucket}/${[t.prefix, key].filter(Boolean).join("/")}`.split("/").map((s) => encodeURIComponent(s)).join("/");
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = ["PUT", objectPath, "", signed.map((h) => `${h}:${headers[h]}\n`).join(""), signed.join(";"), payloadHash].join("\n");
  const scope = `${date}/${t.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, date), t.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
  return { url: `${url.origin}${objectPath}`, headers };
}

export async function s3Put(t: S3Target, key: string, body: Buffer, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { url, headers } = signS3Put(t, key, body);
  const { host: _host, ...sendHeaders } = headers;
  const res = await fetchImpl(url, { method: "PUT", headers: sendHeaders, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`원격 백업 업로드 실패: HTTP ${res.status}`);
}
