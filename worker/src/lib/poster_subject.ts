// [POSTER-SUBJECT-1 2026-09-05] Who the poster is actually OF.
//
// The poster prompt used to describe a scene and nothing else, so the model
// invented a person to put in it — and inventing from a title alone means
// inventing from a stereotype. "Cooking with Davy", filed under Cooking, in
// India, produced a woman in a sari at a stove. The creator is a man, and the
// database knew it: `users.gender` said 'male' and `users.avatar_url` held a
// photo of his face. Neither value had ever been read by the poster pipeline.
//
// Owner decision 2026-09-05, in priority order:
//   1. If the creator's profile photo contains a usable face, paint THAT person.
//   2. If it does not, fall back to the stored gender plus the listing title.
//   3. Either way, the description drives what is happening in the scene.
//
// This module NEVER throws — same contract as listing_poster.ts and
// poster_verify.ts. Every failure path returns a subject with less information
// in it, never an error: a poster with a generic person is a worse poster, but
// a poster that failed to generate is a broken listing.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { generateContentVia } from "./vertex";

const DEFAULT_VISION_MODEL = "gemini-3.7-flash";

/** Profile photos are user uploads. Anything larger than this is not a portrait
 *  worth base64-ing into a Worker isolate with a 128 MB ceiling. */
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

export type PosterSubjectGender = "male" | "female";

export type PosterSubject = {
  /** From `users.gender`, or read off the photo when the column is empty. */
  gender?: PosterSubjectGender | null;
  /** Where the gender came from — carried into telemetry so a wrong poster can
   *  be traced to a wrong profile rather than a wrong prompt. */
  genderSource?: "profile" | "photo" | null;
  /** Set ONLY when the photo passed the face check. Handed to the image model
   *  as `editRef`, i.e. "repaint this person". */
  photoUrl?: string | null;
  /** Why there is no photoUrl. `null` when there is one. */
  photoSkipped?: string | null;
};

function normGender(raw: unknown): PosterSubjectGender | null {
  const g = String(raw ?? "").trim().toLowerCase();
  if (!g) return null;
  if (["male", "man", "m", "he", "he/him"].includes(g)) return "male";
  if (["female", "woman", "f", "she", "she/her"].includes(g)) return "female";
  // Deliberately no third bucket. A creator who is neither, or who has not
  // said, gets NO gender clause in the prompt rather than a guessed one — the
  // absence is handled (the model paints an unspecified person) and a wrong
  // guess is exactly the failure this module exists to stop.
  return null;
}

function parseJsonLoose(raw: string): any | null {
  const cleaned = String(raw || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch { /* ignore */ } }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const FACE_INSTRUCTION = [
  "Look at this profile photograph and answer three questions about it.",
  "Respond with STRICT JSON and nothing else, in this exact shape:",
  '{"faces":<how many distinct human faces are clearly visible>,',
  ' "usable":<true only if exactly one face is clearly visible, unobscured,',
  '           large enough to see the features, and facing roughly forward>,',
  ' "gender":"male" | "female" | "unknown"}',
  "Answer \"unknown\" for gender whenever you are not confident.",
  "A logo, a cartoon, an avatar, an animal or an empty background is not a face.",
].join(" ");

/** Fetch the profile photo and ask whether it is a usable likeness reference. */
async function checkFace(
  env: Env,
  url: string,
): Promise<{ usable: boolean; gender: PosterSubjectGender | null; reason?: string }> {
  let bytes: Uint8Array;
  let mimeType = "image/jpeg";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { usable: false, gender: null, reason: `photo_fetch_${res.status}` };
    const ct = String(res.headers.get("content-type") || "").split(";")[0].trim();
    if (ct.startsWith("image/")) mimeType = ct;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PHOTO_BYTES) return { usable: false, gender: null, reason: "photo_too_large" };
    bytes = new Uint8Array(buf);
  } catch (e) {
    return { usable: false, gender: null, reason: `photo_fetch_failed:${String((e as any)?.message || e).slice(0, 60)}` };
  }

  const model = String((env as any).AVA_VERTEX_TEXT_MODEL || "").trim() || DEFAULT_VISION_MODEL;
  try {
    const r = await generateContentVia(env, model, {
      contents: [{
        role: "user",
        parts: [
          { text: FACE_INSTRUCTION },
          { inlineData: { mimeType, data: toBase64(bytes) } },
        ],
      }],
      generationConfig: { responseModalities: ["TEXT"], temperature: 0 },
    }, "generateContent", { timeoutMs: 30_000 });

    const text = (r.out?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text).filter(Boolean).join("\n");
    const parsed = r.ok ? parseJsonLoose(text) : null;
    if (!parsed) {
      // The checker being unavailable is not evidence about the photo. Fall
      // back to gender-only rather than pasting an unvetted image into the
      // poster prompt — a photo with two faces in it would put a stranger on
      // a public listing.
      return {
        usable: false, gender: null,
        reason: r.ok ? "face_check_unparseable" : `face_check_${r.status}`,
      };
    }
    const usable = parsed.usable === true && Number(parsed.faces ?? 0) === 1;
    return {
      usable,
      gender: normGender(parsed.gender),
      reason: usable ? undefined : `face_check_rejected:faces=${Number(parsed.faces ?? 0)}`,
    };
  } catch (e) {
    return { usable: false, gender: null, reason: `face_check_failed:${String((e as any)?.message || e).slice(0, 60)}` };
  }
}

/**
 * Resolve who the poster should depict.
 *
 * `usePhoto` false skips the fetch and the vision call entirely and returns the
 * profile gender alone — that is the cheap path, and the one that still fixes
 * the reported bug.
 */
export async function resolveCreatorSubject(
  env: Env,
  ownerUid: string,
  opts: {
    usePhoto: boolean;
    /** [FACE-PHOTO-1 2026-09-05] The reference face the creator uploaded FOR
     *  THIS LISTING (`attrs.face_photo`). It wins over the profile avatar,
     *  because it is the photo they chose knowing a poster would be painted
     *  from it — an avatar might be a logo, a group shot, or ten years old. */
    facePhotoUrl?: string | null;
  },
): Promise<PosterSubject> {
  if (!ownerUid) return { gender: null, genderSource: null, photoUrl: null, photoSkipped: "no_owner" };

  let row: any = null;
  try {
    row = await metaDb(env)
      .prepare("SELECT gender, avatar_url FROM users WHERE uid=?1")
      .bind(ownerUid).first<any>();
  } catch (e) {
    return { gender: null, genderSource: null, photoUrl: null, photoSkipped: `profile_read_failed:${String((e as any)?.message || e).slice(0, 60)}` };
  }

  const profileGender = normGender(row?.gender);
  // The listing's own face photo first; the profile avatar is the fallback for a
  // listing made before this was collected.
  const listingFace = String(opts.facePhotoUrl || "").trim();
  const avatar = listingFace || String(row?.avatar_url || "").trim();

  if (!opts.usePhoto) {
    return { gender: profileGender, genderSource: profileGender ? "profile" : null, photoUrl: null, photoSkipped: "photo_disabled" };
  }
  if (!avatar || !/^https:\/\//i.test(avatar)) {
    return { gender: profileGender, genderSource: profileGender ? "profile" : null, photoUrl: null, photoSkipped: "no_photo" };
  }

  const face = await checkFace(env, avatar);
  return {
    // The profile is the creator's own statement about themselves and wins.
    // The photo read is only consulted when they never gave one.
    gender: profileGender ?? face.gender ?? null,
    genderSource: profileGender ? "profile" : face.gender ? "photo" : null,
    photoUrl: face.usable ? avatar : null,
    photoSkipped: face.usable ? null : (face.reason ?? "face_check_rejected"),
  };
}
