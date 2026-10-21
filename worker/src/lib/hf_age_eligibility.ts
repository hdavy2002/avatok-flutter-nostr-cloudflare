import type { Env } from "../types";
import { json } from "../util";

/** Authoritative caller self-attestation, independent of login and phone verification. */
export async function requireHfAgeConfirmation(env: Env, uid: string): Promise<Response | null> {
  try {
    const row = await env.DB_META.prepare("SELECT confirmed_at FROM hf_age_confirm WHERE uid=?1")
      .bind(uid).first<{ confirmed_at: number }>();
    if (row) return null;
    return json({ error: "age_confirmation_required", message: "Please confirm that you are 18 or older to continue." }, 403);
  } catch {
    return json({ error: "age_confirmation_unavailable", message: "We could not check your age confirmation. Please try again later." }, 503);
  }
}
