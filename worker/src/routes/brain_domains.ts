// GET /api/brain/domains — the BRAIN_DOMAINS registry as a wire contract
// (SPEC §3). Authenticated: the Settings UI is generated from this, so a toggle
// can never gate nothing and a capability can never exist without a toggle.
//
// Response: { domains: [{ key, consentKey, basis, deletable, label, default, scope }] }
// basis/deletable (§10.1) let the client render legal-basis rows (consentKey null) as
// a disclosure instead of a switch, and exclude them from delete-my-data.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { brainDomainList } from "../lib/brain_domains";

// [AVABRAIN-ASSET-1] Part VI §47 / task brief item 9 — "separate controls for
// file indexing, image analysis, audio transcription and sensitive-media
// indexing". These four keys are declared HERE (route layer), appended to the
// registry response, rather than added to lib/brain_domains.ts's BRAIN_DOMAINS
// map — that map is `BrainDomain = keyof typeof BRAIN_DOMAINS`, type-checked
// against brainIngest()'s event-routing lane, and is owned by a concurrent
// change this session; injecting here keeps the wire contract additive
// without touching it (see worker/src/lib/brain_assets.ts's header for the
// full rationale). This is NOT a fake flag: `POST /api/brain/consent` already
// accepts any capability string with no registry check, and
// worker/src/lib/brain_assets.ts's assetIngestConsentAllows/
// assetQueryConsentAllows read these EXACT keys directly — toggling one here
// really does gate ingestion and query-time retrieval.
//
// `brain_sensitive_media` defaults OFF (opt-IN), unlike every other AvaBrain
// toggle (opt-out by rulebook default) — Part VI §40 explicitly requires "an
// explicit adult-content/privacy setting before indexing sensitive media".
function assetConsentDomains(): Array<{
  key: string; consentKey: string; label: string; default: boolean; scope: string; basis: string; deletable: boolean;
}> {
  return [
    { key: "brain_image_analysis", consentKey: "brain_image_analysis", label: "Image analysis", default: true, scope: "account_private", basis: "consent", deletable: true },
    { key: "brain_file_indexing", consentKey: "brain_file_indexing", label: "File indexing (PDFs & documents)", default: true, scope: "account_private", basis: "consent", deletable: true },
    { key: "brain_audio_transcription", consentKey: "brain_audio_transcription", label: "Audio transcription", default: true, scope: "account_private", basis: "consent", deletable: true },
    { key: "brain_sensitive_media", consentKey: "brain_sensitive_media", label: "Sensitive media indexing", default: false, scope: "account_private", basis: "consent", deletable: true },
  ];
}

export async function brainDomains(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ domains: [...brainDomainList(), ...assetConsentDomains()] });
}
