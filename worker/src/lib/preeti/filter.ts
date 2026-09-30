// [SAATHUM-PREETI-1 2026-09-30] Output filter for the model's streamed text.
//
// Guarantees, chunk boundaries notwithstanding:
//  * a former brand name/domain never reaches the client (held back until the token is complete, then
//    replaced by the current brand);
//  * a partial `[[event:..]]` / `[[article:..]]` marker never leaks — it is turned into a card token;
//  * the hidden `<<meta {...}>>` trailer never leaks — it is parsed at finish();
//  * YouTube URLs never leak (the whole URL word is held until it ends, then removed).
import type { BrandRuntime } from "./contracts";
import { formerTokens, scrubFormerNames } from "./brand_runtime";

export interface PreetiMeta { lead: number; signal: string; lang: string; mood: string }
export type FilterOut =
  | { kind: "text"; text: string }
  | { kind: "card"; card: "event" | "article"; ref: string };

const MARKER_MAX = 90;
const URL_WORD = /^(h|ht|htt|http|https|https?:.*|www.*|.*youtu.*)$/i;
const YT_URL = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\S*/gi;

export function stripYoutube(text: string): { text: string; hit: boolean } {
  let hit = false;
  const out = text.replace(YT_URL, () => { hit = true; return "[link removed]"; });
  return { text: out, hit };
}

export class StreamFilter {
  private pending = "";
  private metaBuf: string | null = null;
  private seen = new Set<string>();
  private tokens: string[];
  private maxTok: number;
  /** Clean visible text, markers and trailer removed, former names scrubbed. */
  public clean = "";
  public meta: PreetiMeta | null = null;
  public blocked = false;
  public cards: { card: "event" | "article"; ref: string }[] = [];

  constructor(private brand: BrandRuntime) {
    const t = formerTokens(brand);
    this.tokens = [...t.domains, ...t.names].map((s) => s.toLowerCase());
    this.maxTok = this.tokens.reduce((m, s) => Math.max(m, s.length), 0);
  }

  /** Feed a raw chunk; returns what is now safe to emit. */
  push(chunk: string): FilterOut[] {
    if (!chunk) return [];
    if (this.metaBuf !== null) { this.metaBuf += chunk; return []; }
    this.pending += chunk;
    return this.drain(false);
  }

  /** End of stream: release everything that is safe, parse the trailer. */
  finish(): FilterOut[] {
    const out: FilterOut[] = [];
    if (this.metaBuf !== null) this.parseMeta(this.metaBuf);
    else out.push(...this.drain(true));
    this.metaBuf = null;
    this.pending = "";
    return out;
  }

  private emit(out: FilterOut[], raw: string): void {
    if (!raw) return;
    let t = scrubFormerNames(raw, this.brand);
    const y = stripYoutube(t);
    if (y.hit) this.blocked = true;
    t = y.text;
    if (t) { out.push({ kind: "text", text: t }); this.clean += t; }
  }

  private holdLen(s: string): number {
    let hold = 0;
    // trailing partial former token
    const lower = s.toLowerCase();
    for (let n = Math.min(this.maxTok, lower.length); n >= 1 && hold === 0; n--) {
      const suf = lower.slice(lower.length - n);
      if (this.tokens.some((t) => t.startsWith(suf))) hold = n;
    }
    // trailing URL-ish word
    const ws = Math.max(s.lastIndexOf(" "), s.lastIndexOf("\n"), s.lastIndexOf("\t"));
    const word = s.slice(ws + 1);
    if (word && URL_WORD.test(word)) hold = Math.max(hold, word.length);
    return hold;
  }

  private drain(final: boolean): FilterOut[] {
    const out: FilterOut[] = [];
    for (let guard = 0; guard < 200; guard++) {
      const p = this.pending;
      const m = p.search(/\[\[|<</);
      if (m === -1) {
        // a lone trailing "[" or "<" might become a marker start
        let keep = /[[<]$/.test(p) && !final ? 1 : 0;
        const body = p.slice(0, p.length - keep);
        const hold = final ? 0 : this.holdLen(body);
        this.emit(out, body.slice(0, body.length - hold));
        this.pending = p.slice(body.length - hold);
        return out;
      }
      this.emit(out, p.slice(0, m));
      this.pending = p.slice(m);
      const q = this.pending;
      if (q.startsWith("[[")) {
        const end = q.indexOf("]]");
        if (end === -1) {
          if (q.length > MARKER_MAX || final) { this.emit(out, "[["); this.pending = q.slice(2); continue; }
          return out; // wait for the rest of the marker
        }
        const body = q.slice(2, end);
        const mk = /^(event|article)\s*:\s*([A-Za-z0-9_\-./]{1,80})$/.exec(body.trim());
        if (mk) {
          const key = `${mk[1]}:${mk[2]}`;
          if (!this.seen.has(key)) {
            this.seen.add(key);
            this.cards.push({ card: mk[1] as "event" | "article", ref: mk[2] });
            out.push({ kind: "card", card: mk[1] as "event" | "article", ref: mk[2] });
          }
        } // an unrecognised [[...]] is dropped, never shown
        this.pending = q.slice(end + 2);
        continue;
      }
      // "<<"
      const head = q.slice(0, 6);
      if (q.length < 6 && !final && "<<meta".startsWith(q)) return out; // could still become <<meta
      if (head.toLowerCase() === "<<meta") { this.metaBuf = q; this.pending = ""; return out; }
      this.emit(out, "<<");
      this.pending = q.slice(2);
    }
    return out;
  }

  private parseMeta(raw: string): void {
    const m = /<<meta\s*(\{[\s\S]*?\})\s*>>/i.exec(raw);
    if (!m) return;
    try {
      const j = JSON.parse(m[1]);
      const lead = Math.max(0, Math.min(3, Math.trunc(Number(j.lead) || 0)));
      const mood = ["calm", "upset", "angry"].includes(String(j.mood)) ? String(j.mood) : "calm";
      this.meta = { lead, signal: String(j.signal ?? "").slice(0, 120), lang: String(j.lang ?? "").slice(0, 12), mood };
    } catch { /* malformed trailer: ignored, stripped anyway */ }
  }
}

/** Non-streaming convenience for askPreetiOnce / history scrubbing. */
export function filterWhole(text: string, brand: BrandRuntime): { text: string; meta: PreetiMeta | null; cards: { card: "event" | "article"; ref: string }[]; blocked: boolean } {
  const f = new StreamFilter(brand);
  f.push(text);
  f.finish();
  return { text: f.clean.trim(), meta: f.meta, cards: f.cards, blocked: f.blocked };
}
