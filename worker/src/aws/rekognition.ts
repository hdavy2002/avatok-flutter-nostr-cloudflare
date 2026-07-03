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

// ── Content moderation on profile photos (P11 / R2-F2) ───────────────────────
// DetectModerationLabels returns hierarchical safety labels for an image. We
// reject an avatar whose labels include the sexual categories below. Uses the
// same JSON-1.1 `call` helper (SigV4-signed by src/aws/sigv4.ts) as liveness.

/** A single moderation label from Rekognition (Name/ParentName/Confidence). */
export interface ModerationLabel {
  Name?: string;
  ParentName?: string;
  Confidence?: number;
}

/**
 * Run DetectModerationLabels on raw image bytes. `MinConfidence` is the floor
 * (0..100) below which a label is not returned. Throws on a transient/API error
 * (the caller decides fail-open vs fail-closed).
 */
export async function detectModerationLabels(
  env: Env,
  imageBytes: Uint8Array,
  minConfidence = 60,
): Promise<{ ModerationLabels: ModerationLabel[] }> {
  // Rekognition's Image.Bytes is a base64-encoded blob in the JSON-1.1 body.
  let bin = "";
  for (let i = 0; i < imageBytes.length; i++) bin += String.fromCharCode(imageBytes[i]);
  const b64 = btoa(bin);
  const r = await call<{ ModerationLabels?: ModerationLabel[] }>(env, "DetectModerationLabels", {
    Image: { Bytes: b64 },
    MinConfidence: minConfidence,
  });
  return { ModerationLabels: r.ModerationLabels ?? [] };
}

// Top-level moderation categories we reject a PROFILE PHOTO on. Rekognition
// nests specific labels under these parents (e.g. "Exposed Male Genitalia" →
// parent "Explicit Nudity"). We match on either the label Name or its
// ParentName so a new child label under these parents is still caught.
const AVATAR_REJECT_CATEGORIES = [
  "explicit nudity",
  "sexual activity",
];

/**
 * True when the moderation labels contain a rejected sexual category. Matches on
 * Name OR ParentName (case-insensitive substring) so child labels count too.
 */
export function avatarModerationRejected(labels: ModerationLabel[]): { rejected: boolean; label?: string } {
  for (const l of labels ?? []) {
    const name = String(l.Name ?? "").toLowerCase();
    const parent = String(l.ParentName ?? "").toLowerCase();
    for (const cat of AVATAR_REJECT_CATEGORIES) {
      if (name.includes(cat) || parent.includes(cat)) {
        return { rejected: true, label: l.Name ?? l.ParentName ?? cat };
      }
    }
  }
  return { rejected: false };
}
