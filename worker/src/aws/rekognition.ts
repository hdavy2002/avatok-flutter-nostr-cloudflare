// AWS Rekognition Face Liveness client for AvaID (Phase 1, §10.4).
// Uses the Web-Crypto SigV4 signer (src/aws/sigv4.ts) — no AWS SDK on Workers.
// Rekognition uses the JSON-1.1 protocol: POST to the service host with an
// `X-Amz-Target` header naming the operation; body is JSON.
//
// FLAG-GATED: if AWS creds are unset the helpers return { configured:false } and
// the route degrades to "verification unavailable" (HTTP 503). Live creds are
// set per-phase: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
import type { Env } from "../types";
import { signRequest } from "./sigv4";

const SERVICE = "rekognition";

export function rekognitionConfigured(env: Env): boolean {
  return !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION);
}

async function call<T = any>(env: Env, target: string, body: object): Promise<T> {
  const region = env.AWS_REGION!;
  const url = `https://${SERVICE}.${region}.amazonaws.com/`;
  const signed = await signRequest({
    method: "POST",
    url,
    region,
    service: SERVICE,
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: env.AWS_SESSION_TOKEN,
    body: JSON.stringify(body),
    headers: {
      "X-Amz-Target": `RekognitionService.${target}`,
      "Content-Type": "application/x-amz-json-1.1",
    },
  });
  const res = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: signed.body });
  const text = await res.text();
  if (!res.ok) throw new Error(`rekognition ${target} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Start a Face Liveness session. Returns the SessionId the client SDK needs. */
export async function createLivenessSession(
  env: Env,
  opts: { auditImagesLimit?: number; outputBucket?: string; outputKeyPrefix?: string } = {},
): Promise<{ SessionId: string }> {
  const settings: any = {};
  if (typeof opts.auditImagesLimit === "number") settings.AuditImagesLimit = opts.auditImagesLimit;
  if (opts.outputBucket) settings.OutputConfig = { S3Bucket: opts.outputBucket, S3KeyPrefix: opts.outputKeyPrefix };
  return call(env, "CreateFaceLivenessSession", Object.keys(settings).length ? { Settings: settings } : {});
}

/** Fetch results: Confidence 0..100 and Status (CREATED|IN_PROGRESS|SUCCEEDED|FAILED|EXPIRED). */
export async function getLivenessResults(
  env: Env,
  sessionId: string,
): Promise<{ Status: string; Confidence?: number; ReferenceImage?: any }> {
  return call(env, "GetFaceLivenessSessionResults", { SessionId: sessionId });
}
