// [SAATHUM-PREETI-1 2026-09-30] Runtime brand for Preeti. Everything customer-visible reads the brand
// from here at reply time, so a brand/domain change (admin "Brand & domain" card) is one row, not a
// redeploy. Source of truth: brand_settings (DB_META) when present, else the generated BRAND constants
// (Specs/brand.json) plus the seeded former names. The brand literal is never typed in this file.
import type { Env } from "../../types";
import { BRAND } from "../brand";
import type { BrandRuntime } from "./contracts";

const CACHE_MS = 60_000;
let cache: { at: number; brand: BrandRuntime } | null = null;

/** Seeded former names, per owner decision 2026-09-30. Scrubbing is case-insensitive. */
const SEED_FORMER: BrandRuntime["former"] = [{ name: "avaTOK", domain: "avatok.ai" }];

function fallbackBrand(): BrandRuntime {
  return {
    name: BRAND.name,
    domain: BRAND.domain,
    site: BRAND.webOrigin,
    former: SEED_FORMER.map((f) => ({ ...f })),
  };
}

function parseFormer(raw: unknown): BrandRuntime["former"] {
  try {
    const arr = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((f: any) => ({ name: String(f?.name ?? "").trim(), domain: f?.domain ? String(f.domain).trim() : null }))
      .filter((f) => f.name.length > 0);
  } catch {
    return [];
  }
}

export async function currentBrand(env: Env): Promise<BrandRuntime> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.brand;
  let brand = fallbackBrand();
  try {
    const row = await env.DB_META.prepare(
      "SELECT name, domain, web_origin, former_json FROM brand_settings WHERE id=1",
    ).first<{ name: string; domain: string; web_origin: string; former_json: string }>();
    if (row?.name && row.domain) {
      brand = {
        name: row.name,
        domain: row.domain,
        site: row.web_origin || `https://${row.domain}`,
        former: parseFormer(row.former_json),
      };
    }
  } catch {
    // Table not migrated yet (or D1 blip): the generated constants are always a safe answer.
  }
  cache = { at: Date.now(), brand };
  return brand;
}

export function invalidateBrandCache(): void {
  cache = null;
}

/** {agent} {brand} {domain} {site} -> live values. Unknown braces are left alone. */
export function fillPlaceholders(text: string, brand: BrandRuntime, agentName: string): string {
  return String(text ?? "")
    .replace(/\{agent\}/g, agentName)
    .replace(/\{brand\}/g, brand.name)
    .replace(/\{domain\}/g, brand.domain)
    .replace(/\{site\}/g, brand.site);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Former tokens worth scrubbing (domains first: longer, and they contain the names). */
export function formerTokens(brand: BrandRuntime): { domains: string[]; names: string[] } {
  const cur = brand.name.toLowerCase();
  const curDom = brand.domain.toLowerCase();
  const domains = new Set<string>();
  const names = new Set<string>();
  for (const f of brand.former) {
    const n = f.name.trim();
    const d = (f.domain ?? "").trim();
    // Never scrub a token that is (or sits inside) the CURRENT brand, or the site would be blanked.
    if (n && n.toLowerCase() !== cur && !cur.includes(n.toLowerCase())) names.add(n);
    if (d && d.toLowerCase() !== curDom && !curDom.includes(d.toLowerCase())) domains.add(d);
  }
  return { domains: [...domains].sort((a, b) => b.length - a.length), names: [...names].sort((a, b) => b.length - a.length) };
}

/** Replace any former name/domain (any case, optional www.) by the current one. */
export function scrubFormerNames(text: string, brand: BrandRuntime): string {
  if (!text) return text;
  const { domains, names } = formerTokens(brand);
  let out = text;
  for (const d of domains) out = out.replace(new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?${escRe(d)}`, "gi"), (m) => (/^https?:\/\//i.test(m) ? brand.site : brand.domain));
  for (const n of names) out = out.replace(new RegExp(escRe(n), "gi"), brand.name);
  return out;
}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/**
 * Change the brand. The CURRENT name/domain move into `former` (so they are scrubbed from every future
 * reply), a new name that used to be a former one is un-forgotten. Validates domain host syntax only.
 */
export async function setBrand(env: Env, input: { name: string; domain: string }, byUid: string): Promise<BrandRuntime> {
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  const domain = String(input.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (name.length < 2 || name.length > 60) throw new Error("brand name must be 2-60 characters");
  if (!HOST_RE.test(domain)) throw new Error("invalid domain");
  const cur = await currentBrand(env);
  const former = cur.former.filter(
    (f) => f.name.toLowerCase() !== name.toLowerCase() && (f.domain ?? "").toLowerCase() !== domain,
  );
  if (cur.name.toLowerCase() !== name.toLowerCase() || cur.domain.toLowerCase() !== domain) {
    // [SAATHUM-PREETI-1 review] Retire every spelling of the outgoing name, not just the sentence form:
    // the no-space form, and — when leaving the generated brand — its compact and Hindi forms too.
    const variants = [cur.name, cur.name.replace(/\s+/g, "")];
    if (cur.name === BRAND.name) variants.push(BRAND.nameCompact, BRAND.nameHindi);
    for (const v of variants) {
      const t = String(v ?? "").trim();
      if (!t || t.toLowerCase() === name.toLowerCase()) continue;
      if (!former.some((f) => f.name.toLowerCase() === t.toLowerCase())) former.push({ name: t, domain: t === cur.name ? cur.domain : null });
    }
  }
  const next: BrandRuntime = { name, domain, site: `https://${domain}`, former };
  await env.DB_META.prepare(
    `INSERT INTO brand_settings (id, name, domain, web_origin, former_json, changed_at, changed_by)
     VALUES (1,?1,?2,?3,?4,?5,?6)
     ON CONFLICT(id) DO UPDATE SET name=?1, domain=?2, web_origin=?3, former_json=?4, changed_at=?5, changed_by=?6`,
  ).bind(name, domain, next.site, JSON.stringify(former), Date.now(), byUid).run();
  invalidateBrandCache();
  return next;
}
