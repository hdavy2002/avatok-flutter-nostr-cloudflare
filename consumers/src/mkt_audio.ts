// avatok-consumers — marketplace agent-negotiation VOICE render.
//
// The negotiation itself + the TEXT deal card are delivered synchronously by
// avatok-api. The voice note (Gemini multi-speaker TTS of the FULL transcript)
// is SLOW — 30-60s for a real multi-round negotiation — which does NOT fit inside
// the request/waitUntil budget of the API Worker (it was getting reaped → "No
// audio"). So avatok-api enqueues a `mkt-audio` message and THIS consumer renders
// it with the queue's own generous per-message budget, then appends the voice
// card to both parties' InboxDOs and nudges the live thread. Robust at scale:
// millions of renders fan out across the queue instead of hanging request paths.
import type { Env, MktAudioMsg } from "./types";

const TTS_MODEL = "gemini-2.5-flash-preview-tts";

/** BCP-47 short code → English language name (for the "Speak in <language>."
 *  preamble). Mirrors LANG_NAMES in worker/src/routes/marketplace.ts. */
const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", hi: "Hindi", fr: "French", de: "German",
  pt: "Portuguese", ar: "Arabic", zh: "Chinese", ja: "Japanese", ru: "Russian",
  id: "Indonesian", ur: "Urdu", bn: "Bengali", sw: "Swahili", tr: "Turkish", vi: "Vietnamese",
};
function langName(code?: string): string {
  return LANG_NAMES[String(code || "en").toLowerCase()] || "English";
}

/** Verified Gemini prebuilt voice ids (buyer picker mirror). A value outside this
 *  set falls back to Aoede so a stale/bad pref can never break the render. */
const GEMINI_VOICES = new Set([
  "Aoede", "Kore", "Leda", "Zephyr", "Autonoe", "Callirrhoe", "Despina", "Erinome",
  "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat", "Achird", "Sadachbia",
  "Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Zubenelgenubi", "Sadaltager",
]);
function buyerVoiceOr(v?: string | null): string {
  return v && GEMINI_VOICES.has(v) ? v : "Aoede";
}

/** Must match worker/src/lib/delivery.ts marketplaceMessageId(..., "audio"). */
export function mktAudioMessageId(artifactId: string): string {
  return `${artifactId}:audio`;
}

/** Stable logical row shared by buyer and seller. Audio enriches this row. */
export function mktResultMessageId(artifactId: string): string {
  return `${artifactId}:result`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wrap 24kHz mono 16-bit PCM as a playable WAV (chat voice notes are WAV). */
function pcmToWav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const ch = 1, bits = 16;
  const byteRate = (sampleRate * ch * bits) / 8, block = (ch * bits) / 8;
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, byteRate, true);
  v.setUint16(32, block, true); v.setUint16(34, bits, true); w(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(head), 0); out.set(pcm, 44);
  return out;
}

/** Render the FULL 2-voice negotiation transcript to a WAV via Gemini TTS. null on
 *  error. MKT-LANG-4: the transcript is already in the buyer's language; we prepend
 *  a "Speak in <language>." preamble, use the buyer's chosen voice for the Buyer
 *  speaker (fallback Aoede), and the listing persona/style for the Seller (fallback
 *  Charon). This is the direct-render fallback; the primary path renders inside a
 *  US-pinned PartyDO (see handleMktAudio → /render-tts). */
async function renderNegotiationWav(
  env: Env,
  transcript: Array<{ speaker: string; text: string }>,
  persona?: string,
  lang?: string,
  buyerVoice?: string | null,
): Promise<Uint8Array | null> {
  const key = env.RECEPTIONIST_GEMINI_API_KEY || env.GEMINI_API_KEY;
  if (!key || !transcript.length) return null;
  const styleHint = persona && persona.trim() ? ` The Seller speaks in this style/accent: ${persona.trim()}.` : "";
  const speakIn = ` Speak in ${langName(lang)}.`;
  const script = `TTS this marketplace negotiation between two agents, natural and businesslike.${speakIn}${styleHint}\n` +
    transcript.map((t) => `${t.speaker === "Buyer" ? "Buyer" : "Seller"}: ${t.text}`).join("\n");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: script }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
        // Seller = listing persona/style (fallback Charon); Buyer = buyer's pick (fallback Aoede).
        { speaker: "Seller", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
        { speaker: "Buyer", voiceConfig: { prebuiltVoiceConfig: { voiceName: buyerVoiceOr(buyerVoice) } } },
      ] } },
    },
  };
  // 90s: the consumer has its own per-message budget, so a full multi-round
  // render can take its time here (unlike the API Worker's request path).
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`tts ${res.status}: ${raw.slice(0, 200)}`);
  let j: any = null;
  try { j = JSON.parse(raw); } catch { /* non-JSON body */ }
  const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (typeof data !== "string") {
    console.error(`[mkt-audio] no audio in TTS 200: finishReason=${j?.candidates?.[0]?.finishReason} keys=${JSON.stringify(Object.keys(j || {}))} raw=${raw.slice(0, 300)}`);
    return null;
  }
  return pcmToWav(b64ToBytes(data));
}

/** Append a deterministic message to a user's InboxDO. */
async function inboxAppend(
  env: Env, recipient: string, sender: string, conv: string, envelope: string,
  mediaRef: string | null, clientId: string, mid: string, createdAt: number,
): Promise<{ id: number; live: boolean; alreadyProcessed: boolean }> {
  const INBOX = env.INBOX;
  if (!INBOX) throw new Error("mkt_audio_inbox_unbound");
  const stub = INBOX.get(INBOX.idFromName(recipient));
  const res = await stub.fetch("https://inbox/append", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv, sender, kind: "text", body: envelope, media_ref: mediaRef, client_id: clientId, mid, created_at: createdAt, owner: recipient }),
  });
  const out = await res.json().catch(() => ({})) as { id?: number; live?: boolean; already_processed?: boolean; error?: string };
  if (!res.ok || out.error) throw new Error(`mkt_audio_inbox_append_failed:${res.status}:${out.error || "unknown"}`);
  return { id: Number(out.id || 0), live: out.live === true, alreadyProcessed: out.already_processed === true };
}

async function inboxPatch(env: Env, recipient: string, clientId: string, envelope: string): Promise<{ found: boolean; live: boolean }> {
  const INBOX = env.INBOX;
  if (!INBOX) throw new Error("mkt_audio_inbox_unbound");
  const stub = INBOX.get(INBOX.idFromName(recipient));
  const res = await stub.fetch("https://inbox/msg_body", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, body: envelope }),
  });
  const out = await res.json().catch(() => ({})) as { found?: boolean; live?: boolean; error?: string };
  if (!res.ok || out.error) throw new Error(`mkt_audio_inbox_patch_failed:${res.status}:${out.error || "unknown"}`);
  return { found: out.found === true, live: out.live === true };
}

/** Patch the durable result row, append only for a legacy/partial inbox. */
async function upsertResult(
  env: Env,
  m: MktAudioMsg,
  envelope: string,
  clientId: string,
  mid: string,
  mediaRef: string,
): Promise<{ buyer: { found: boolean; live: boolean }; seller: { found: boolean; live: boolean } }> {
  const [buyerPatch, sellerPatch] = await Promise.all([
    inboxPatch(env, m.buyerUid, clientId, envelope),
    inboxPatch(env, m.sellerUid, clientId, envelope),
  ]);
  const createdAt = Date.now();
  const buyer = buyerPatch.found ? buyerPatch : await inboxAppend(env, m.buyerUid, m.sellerUid, m.conv, envelope, mediaRef, clientId, mid, createdAt);
  const seller = sellerPatch.found ? sellerPatch : await inboxAppend(env, m.sellerUid, m.buyerUid, m.conv, envelope, mediaRef, clientId, mid, createdAt);
  return {
    buyer: { found: true, live: buyer.live },
    seller: { found: true, live: seller.live },
  };
}

/** Nudge the live thread room so an open chat pulls the new voice card instantly. */
async function partyEmit(env: Env, room: string, event: Record<string, unknown>): Promise<void> {
  const PARTY = env.PARTY;
  if (!PARTY) return;
  try {
    await PARTY.get(PARTY.idFromName(room)).fetch("https://party/emit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event),
    });
  } catch { /* best-effort */ }
}

// AWAIT the analytics send: in a queue consumer a fire-and-forget promise is
// dropped when the invocation ends, so the previous `void ...send()` telemetry
// never flushed (which is why the consumer looked silent). Returns the promise.
async function track(env: Env, uid: string, event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await env.Q_ANALYTICS?.send({ event, uid, ts: Date.now(),
      props: { ...props, app_name: "avatok", service_name: "avatok-consumers", worker: true, account_id: uid } });
  } catch { /* best-effort */ }
}

export async function handleMktAudio(m: MktAudioMsg, env: Env): Promise<void> {
  const t0 = Date.now();
  console.log(`[mkt-audio] start listing=${m.listingId} negotiation=${m.negotiationId} conv=${m.conv} lines=${(m.transcript || []).length}`);
  await track(env, m.buyerUid, "mkt_audio_start", { listing_id: m.listingId, negotiation_id: m.negotiationId, conv: m.conv, lines: (m.transcript || []).length, lang: m.lang || "en", buyer_voice: buyerVoiceOr(m.buyerVoice) });
  try {
    if (!m.negotiationId || !m.artifactId) throw new Error("mkt_audio_identity_missing");
    const artifact = await env.DB_META.prepare(
      `SELECT a.negotiation_id, a.buyer_id, a.seller_id, a.listing_id, a.audio_key,
              a.outcome, a.approval_status, a.agreed_price, a.currency,
              a.transcript_en, a.transcript_i18n, a.summary,
              a.render_status, a.render_claimed_at,
              a.result_buyer_delivered_at, a.result_seller_delivered_at,
              a.seller_push_sent_at,
              r.approval_status AS run_approval_status,
              r.outcome AS run_outcome, r.agreed_price AS run_agreed_price,
              r.currency AS run_currency
         FROM mkt_negotiation_artifacts a
         LEFT JOIN mkt_negotiation_runs r ON r.negotiation_id=a.negotiation_id
        WHERE a.negotiation_id=?1 LIMIT 1`,
    ).bind(m.negotiationId).first<any>();
    if (!artifact) throw new Error("mkt_audio_artifact_missing");
    if (String(artifact.buyer_id) !== m.buyerUid || String(artifact.seller_id) !== m.sellerUid || String(artifact.listing_id) !== m.listingId) {
      throw new Error("mkt_audio_participants_mismatch");
    }

    // ETA (owner ask): if this render sat in a BACKLOG before we picked it up,
    // post a reassuring interim note so the buyer doesn't give up. The message's
    // age in the queue is the backlog signal (deep queue → long wait).
    const waitedMs = m.enqueuedAt ? Date.now() - m.enqueuedAt : 0;
    if (waitedMs > 45000) {
      const etaMin = Math.max(1, Math.round(waitedMs / 60000));
      const note = JSON.stringify({ t: "text", body: `🕐 Your agents are busy right now — the voice conversation is taking a little longer than usual. It should arrive in about ${etaMin} minute${etaMin > 1 ? "s" : ""}. Feel free to leave and come back; it'll be waiting here.` });
      const etaId = `${m.artifactId}:eta`;
      await inboxAppend(env, m.buyerUid, m.sellerUid, m.conv, note, null, etaId, etaId, Date.now());
      await partyEmit(env, `thread:${m.conv}`, { t: "deal_ready", kind: "eta", listing_id: m.listingId, conv: m.conv });
      await track(env, m.buyerUid, "mkt_audio_eta_sent", { listing_id: m.listingId, negotiation_id: m.negotiationId, conv: m.conv, waited_ms: waitedMs });
    }
    // Approval may have changed while this queue item was waiting. Reread the
    // durable run/artifact state and never publish a stale pending-approval card.
    const approvalStatus = String(artifact.run_approval_status || artifact.approval_status || "not_required");
    const currentOutcome = String(artifact.run_outcome || artifact.outcome || m.outcome);
    const currentAgreed = Number(artifact.run_agreed_price ?? artifact.agreed_price ?? m.agreed ?? 0);
    const currentCurrency = String(artifact.run_currency || artifact.currency || m.currency || "USD");
    const currentTranscriptEn = artifact.transcript_en ? JSON.parse(String(artifact.transcript_en)) : (m.transcriptEn || m.transcript || []);
    const currentI18n = artifact.transcript_i18n ? JSON.parse(String(artifact.transcript_i18n)) : (m.transcriptI18n || undefined);
    const currentTranscript = Array.isArray(currentI18n?.[m.lang || ""])
      ? currentI18n[m.lang || ""]
      : (Array.isArray(currentI18n?.en) ? currentI18n.en : m.transcript);
    const currentSummary = String(artifact.summary || m.summary || "");

    let audioKey = artifact.audio_key as string | null;
    let renderedBytes = 0;
    if (!audioKey) {
      const claimAt = Date.now();
      const claim = await env.DB_META.prepare(
        `UPDATE mkt_negotiation_artifacts
            SET render_status='rendering', render_claimed_at=?2,
                render_attempts=COALESCE(render_attempts,0)+1, last_error=NULL, updated_at=?2
          WHERE negotiation_id=?1 AND audio_key IS NULL
            AND (render_status IN ('queued','retryable')
              OR (render_status='rendering' AND (render_claimed_at IS NULL OR render_claimed_at < ?2 - 900000)))`,
      ).bind(m.negotiationId, claimAt).run();
      if ((claim.meta?.changes ?? 0) !== 1) {
        // Another delivery is actively rendering this artifact. It owns the
        // provider call; this duplicate can safely ack and let that invocation
        // perform the patch.
        const fresh = await env.DB_META.prepare(
          "SELECT audio_key, render_status FROM mkt_negotiation_artifacts WHERE negotiation_id=?1 LIMIT 1",
        ).bind(m.negotiationId).first<any>();
        if (fresh?.audio_key) audioKey = String(fresh.audio_key);
        else if (String(fresh?.render_status) === "rendering") return;
        else throw new Error("mkt_audio_render_claim_unavailable");
      }
    }
    if (!audioKey) {
      // Render inside a US-PINNED PartyDO. Redeliveries reuse the persisted
      // audio_key, so only an unfinished render calls TTS again.
      const PARTY = env.PARTY;
      if (!PARTY) throw new Error("mkt_audio_party_unbound");
      const stub = PARTY.get(PARTY.idFromName("ttsr-" + m.negotiationId), { locationHint: "wnam" });
      const rr = await stub.fetch("https://party/render-tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript: m.transcript || [], persona: m.persona, listingId: m.listingId,
          lang: m.lang || "en", buyerVoice: buyerVoiceOr(m.buyerVoice),
        }),
      });
      const rj = (await rr.json().catch(() => ({}))) as { audio_key?: string | null; bytes?: number };
      if (!rr.ok || !rj.audio_key) {
        await track(env, m.buyerUid, "mkt_audio_render_failed", { listing_id: m.listingId, negotiation_id: m.negotiationId, conv: m.conv, reason: "do_null", status: rr.status });
        await env.DB_META.prepare(
          "UPDATE mkt_negotiation_artifacts SET render_status='retryable', render_claimed_at=NULL, last_error=?2, updated_at=?3 WHERE negotiation_id=?1",
        ).bind(m.negotiationId, `mkt_audio_render_failed:${rr.status}`, Date.now()).run();
        throw new Error(`mkt_audio_render_failed:${rr.status}`);
      }
      audioKey = rj.audio_key;
      renderedBytes = Number(rj.bytes || 0);
      await env.DB_META.prepare(
        `UPDATE mkt_negotiation_artifacts
            SET audio_key=?2, audio_bytes=?3, render_status='rendered', render_claimed_at=NULL, last_error=NULL, updated_at=?4
          WHERE negotiation_id=?1`,
      ).bind(m.negotiationId, audioKey, renderedBytes, Date.now()).run();
    }
    if (!audioKey) throw new Error("mkt_audio_key_missing");
    const envelope = JSON.stringify({
      t: "marketplace_deal", text: "🎙️ Voice replay of the negotiation", outcome: currentOutcome,
      bubble: currentOutcome === "deal" ? "green" : "pale_yellow",
      agreed_price: currentAgreed, currency: currentCurrency, listing_id: m.listingId, transcript: currentTranscript,
      negotiation_id: m.negotiationId, artifact_id: m.artifactId,
      buyer_id: m.buyerUid, seller_id: m.sellerUid,
      has_audio: true, audio_key: audioKey,
      // MKT-LANG: buyer language + i18n cache (so a reopen renders the right text
      // WITHOUT re-translating) + English canonical + owner-approval flag.
      lang: m.lang || "en",
      transcript_en: currentTranscriptEn,
      transcript_i18n: currentI18n,
      summary: currentSummary,
      pending_owner_approval: approvalStatus === "pending",
    });
    const clientId = mktResultMessageId(m.artifactId);
    const mid = clientId;
    const result = await upsertResult(env, m, envelope, clientId, mid, audioKey);
    await env.DB_META.prepare(
      `UPDATE mkt_negotiation_artifacts
          SET result_buyer_message_id=?2, result_seller_message_id=?2,
              result_buyer_delivered_at=?3, result_seller_delivered_at=?3,
              delivery_attempts=COALESCE(delivery_attempts,0)+1,
              delivery_status='complete', last_error=NULL, updated_at=?3
        WHERE negotiation_id=?1`,
    ).bind(m.negotiationId, clientId, Date.now()).run();
    console.log(`[mkt-audio] result enrichment buyer_live=${result.buyer.live} seller_live=${result.seller.live}`);
    // Seller did not initiate the negotiation, so wake that account using the
    // existing normal chat-notify queue. The buyer converges silently on the
    // durable InboxDO row during the next Messenger sync.
    if (env.Q_PUSH && artifact.seller_push_sent_at == null) {
      await env.Q_PUSH.send({
        kind: "notify", to: m.sellerUid, from: m.buyerUid, fromName: "AvaMarketplace",
        title: "Marketplace negotiation ready", body: "A new agent conversation is ready in Messenger.",
        preview: "A new marketplace negotiation replay is ready.", conv: m.conv, mid,
        data: { type: "marketplace_deal", listing_id: m.listingId, negotiation_id: m.negotiationId },
      });
      await env.DB_META.prepare(
        "UPDATE mkt_negotiation_artifacts SET seller_push_sent_at=?2, updated_at=?2 WHERE negotiation_id=?1",
      ).bind(m.negotiationId, Date.now()).run();
    }
    await partyEmit(env, `thread:${m.conv}`, { t: "deal_ready", kind: "audio", listing_id: m.listingId, conv: m.conv });
    console.log(`[mkt-audio] delivered both sides listing=${m.listingId} negotiation=${m.negotiationId} bytes=${renderedBytes} ms=${Date.now() - t0}`);
    await track(env, m.buyerUid, "mkt_audio_delivered", { listing_id: m.listingId, conv: m.conv, negotiation_id: m.negotiationId, buyer_delivered: true, seller_delivered: true, bytes: renderedBytes, ms: Date.now() - t0, lang: m.lang || "en", buyer_voice: buyerVoiceOr(m.buyerVoice) });
  } catch (e) {
    console.error(`[mkt-audio] ERROR listing=${m.listingId}: ${String(e)}`);
    await track(env, m.buyerUid, "mkt_audio_error", { listing_id: m.listingId, negotiation_id: m.negotiationId, conv: m.conv, error: String(e).slice(0, 300), ms: Date.now() - t0 });
    try {
      await env.DB_META.prepare(
        `UPDATE mkt_negotiation_artifacts
            SET render_status=CASE WHEN audio_key IS NULL AND render_status='rendering' THEN 'retryable' ELSE render_status END,
                render_claimed_at=CASE WHEN audio_key IS NULL THEN NULL ELSE render_claimed_at END,
                last_error=?2, updated_at=?3
          WHERE negotiation_id=?1`,
      ).bind(m.negotiationId, String(e).slice(0, 500), Date.now()).run();
    } catch { /* preserve the original queue failure */ }
    throw e;
  }
}
