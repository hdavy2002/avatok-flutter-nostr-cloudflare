import type { Env } from "../types";
import type { TierId } from "../routes/plans";
import type { GenerateImageOptions } from "../routes/ava_image";

/** The prompt is transient user input. It is sealed before entering D1. */
export interface QueuedImageInput {
  prompt: string;
  editRef?: string;
  private: boolean;
  statusId?: string;
  chipLabel: string;
  tier: TierId;
  genOptions: GenerateImageOptions;
  timeToPlaceholderMs: number;
  gateChainMs: number;
  createdAt: number;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function cryptoKey(env: Env, jobId: string): Promise<CryptoKey> {
  // A dedicated secret is preferred. The fallbacks keep existing staging/prod
  // deployments functional until the secret is provisioned everywhere.
  const secret = env.AI_MEDIA_INPUT_KEY || env.VENICE_API_KEY || env.OPENROUTER_API_KEY || env.JWT_SECRET;
  if (!secret) throw new Error("ai_media_input_key_missing");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}\0${jobId}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealQueuedImageInput(env: Env, jobId: string, ownerUid: string, input: QueuedImageInput): Promise<void> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey(env, jobId);
  const plaintext = new TextEncoder().encode(JSON.stringify(input));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
  const now = Date.now();
  await env.DB_MEDIA.prepare(
    `INSERT INTO ai_media_job_inputs (job_id, owner_uid, nonce, ciphertext, created_at, expires_at)
     VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(job_id) DO UPDATE SET owner_uid=?2, nonce=?3, ciphertext=?4, created_at=?5, expires_at=?6`,
  ).bind(jobId, ownerUid, b64(nonce), b64(ciphertext), now, now + 24 * 60 * 60 * 1000).run();
}

export async function loadQueuedImageInput(env: Env, jobId: string, ownerUid: string): Promise<QueuedImageInput | null> {
  const row = await env.DB_MEDIA.prepare(
    "SELECT nonce, ciphertext, expires_at FROM ai_media_job_inputs WHERE job_id=?1 AND owner_uid=?2",
  ).bind(jobId, ownerUid).first<{ nonce: string; ciphertext: string; expires_at: number }>();
  if (!row || Number(row.expires_at) < Date.now()) return null;
  const key = await cryptoKey(env, jobId);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(row.nonce) }, key, fromB64(row.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as QueuedImageInput;
}

export async function deleteQueuedImageInput(env: Env, jobId: string): Promise<void> {
  await env.DB_MEDIA.prepare("DELETE FROM ai_media_job_inputs WHERE job_id=?1").bind(jobId).run();
}

export async function purgeExpiredQueuedImageInputs(env: Env, limit = 500): Promise<number> {
  const rows = await env.DB_MEDIA.prepare(
    "SELECT job_id FROM ai_media_job_inputs WHERE expires_at<?1 ORDER BY expires_at LIMIT ?2",
  ).bind(Date.now(), limit).all<{ job_id: string }>();
  let removed = 0;
  for (const row of rows.results || []) {
    const result = await env.DB_MEDIA.prepare("DELETE FROM ai_media_job_inputs WHERE job_id=?1").bind(row.job_id).run();
    removed += result.meta?.changes ?? 0;
  }
  return removed;
}
