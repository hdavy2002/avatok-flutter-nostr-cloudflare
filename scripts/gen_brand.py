#!/usr/bin/env python3
"""[SAATHUM-BRAND-CENTRAL-1 2026-09-30] Generate the brand mirrors from Specs/brand.json.

The public brand name and domain live in ONE file, Specs/brand.json. This
script writes a read-only mirror of it for every surface that needs it:

    web/src/lib/brand.ts        Astro website
    worker/src/lib/brand.ts     Cloudflare Worker (API, emails, WhatsApp text)
    consumers/src/brand.ts      queue consumers (email delivery etc.)
    app/lib/core/brand.dart     Flutter app
    worker/wrangler.toml        production [vars] + api route (targeted line edits only)

Usage:
    python3 scripts/gen_brand.py            # write the mirrors
    python3 scripts/gen_brand.py --check    # exit 1 if any mirror is stale

Same model as scripts/gen_listing_taxonomy.py: mirrors are committed, and a
hand edit to one is overwritten on the next run. Plain python3, no deps.
"""
from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Specs" / "brand.json"

TS_TARGETS = [
    ROOT / "web" / "src" / "lib" / "brand.ts",
    ROOT / "worker" / "src" / "lib" / "brand.ts",
    ROOT / "consumers" / "src" / "brand.ts",
]
WEB_TARGET = TS_TARGETS[0]
WEB_LEGACY_TARGET = ROOT / "web" / "src" / "lib" / "brandLegacy.ts"
DART_TARGET = ROOT / "app" / "lib" / "core" / "brand.dart"
WRANGLER_TARGET = ROOT / "worker" / "wrangler.toml"
CONSUMERS_WRANGLER = ROOT / "consumers" / "wrangler.toml"

REQUIRED = ["name", "nameUpper", "nameCompact", "slug", "nameHindi", "slogan",
            "domain", "hosts", "emails", "emailFromName", "playPackageId"]
REQUIRED_HOSTS = ["api", "media", "auth", "mail"]
REQUIRED_EMAILS = ["support", "noreply", "hello"]

HEADER = ("GENERATED FROM Specs/brand.json by scripts/gen_brand.py — DO NOT EDIT.\n"
          "To change the brand name or domain, edit Specs/brand.json and re-run the script.")


def load() -> dict:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    missing = [k for k in REQUIRED if k not in data]
    missing += [f"hosts.{k}" for k in REQUIRED_HOSTS if k not in data.get("hosts", {})]
    missing += [f"emails.{k}" for k in REQUIRED_EMAILS if k not in data.get("emails", {})]
    if missing:
        sys.exit(f"gen_brand: Specs/brand.json is missing: {', '.join(missing)}")
    dom = data["domain"]
    if dom.startswith("http") or "/" in dom:
        sys.exit("gen_brand: `domain` must be a bare host like saathum.com (no scheme, no path)")
    return data


def js(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def dart(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("$", "\\$") + "'"


def legacy_domains(b: dict) -> list:
    return list(b.get("legacyDomains", []))


def ts_list(items: list) -> str:
    return "[" + ", ".join(js(i) for i in items) + "] as readonly string[]"


def dart_list(items: list) -> str:
    return "<String>[" + ", ".join(dart(i) for i in items) + "]"


def render_ts(b: dict, client: bool = False) -> str:
    """client=True (web): legacy-domain data is NOT put in BRAND (it would ship in every browser
    chunk); it goes to brandLegacy.ts, imported from server-only code behind import.meta.env.SSR."""
    h, e = b["hosts"], b["emails"]
    legacy = legacy_domains(b)
    lines = ["/**"] + [f" * {l}" for l in HEADER.splitlines()] + [" */", ""]
    lines += [
        "export const BRAND = {",
        f"  /** How the name is written in sentences. */",
        f"  name: {js(b['name'])},",
        f"  /** Headings / logo text. */",
        f"  nameUpper: {js(b['nameUpper'])},",
        f"  /** Display name used inside customer-visible sentences ({{brand}} i18n token). Same as name unless the brand wants a variant. */",
        f"  nameCompact: {js(b['nameCompact'])},",
        f"  /** Lowercase, no spaces — hashtags, file names, UA markers. */",
        f"  slug: {js(b['slug'])},",
        f"  nameHindi: {js(b['nameHindi'])},",
        f"  slogan: {js(b['slogan'])},",
        f"  /** One-sentence meaning of the name (front page). */",
        f"  nameMeaningShort: {js(b.get('nameMeaningShort', ''))},",
        f"  /** Full story of the name (About page, help). */",
        f"  nameMeaningLong: {js(b.get('nameMeaningLong', ''))},",
        f"  /** Bare host, no scheme. */",
        f"  domain: {js(b['domain'])},",
        f"  /** https://<domain> — no trailing slash. */",
        f"  webOrigin: {js('https://' + b['domain'])},",
        f"  apiHost: {js(h['api'])},",
        f"  apiOrigin: {js('https://' + h['api'])},",
        f"  mediaHost: {js(h['media'])},",
        f"  mediaOrigin: {js('https://' + h['media'])},",
        f"  authHost: {js(h['auth'])},",
        f"  authOrigin: {js('https://' + h['auth'])},",
        f"  mailHost: {js(h['mail'])},",
    ] + ([] if client else [
        "  /** Former domains. Their api./media. hosts stay attached forever (old app builds, old emails, stored image URLs). */",
        f"  legacyDomains: {ts_list(legacy)},",
        f"  legacyMediaHosts: {ts_list(['media.' + d for d in legacy])},",
        f"  legacyApiHosts: {ts_list(['api.' + d for d in legacy])},",
    ]) + [
        "  emails: {",
        f"    support: {js(e['support'])},",
        f"    noreply: {js(e['noreply'])},",
        f"    hello: {js(e['hello'])},",
        "  },",
        f"  emailFromName: {js(b['emailFromName'])},",
        f"  /** PERMANENT — a Play package id can never change. */",
        f"  playPackageId: {js(b['playPackageId'])},",
        "} as const;",
        "",
        "/** Absolute URL on the public website: brandUrl('/l/abc') -> https://<domain>/l/abc */",
        "export function brandUrl(path = '/'): string {",
        "  return BRAND.webOrigin + (path.startsWith('/') ? path : `/${path}`);",
        "}",
        "",
        "/** True for the brand domain and any subdomain of it. */",
        "export function isBrandHost(host: string): boolean {",
        "  const h = host.toLowerCase();",
        "  return h === BRAND.domain || h.endsWith(`.${BRAND.domain}`);",
        "}",
        "",
    ]
    if not client:
        lines += [
        "/** True for the brand domain, any legacy domain, and any subdomain of either. */",
        "export function isBrandOrLegacyHost(host: string): boolean {",
        "  const h = host.toLowerCase();",
        "  if (isBrandHost(h)) return true;",
        "  return BRAND.legacyDomains.some((d) => h === d || h.endsWith(`.${d}`));",
        "}",
        "",
        ]
    return "\n".join(lines)


def render_legacy_ts(b: dict) -> str:
    legacy = legacy_domains(b)
    lines = ["/**"] + [f" * {l}" for l in HEADER.splitlines()] + [" */", ""]
    lines += [
        "/** SERVER-ONLY. Import behind `import.meta.env.SSR` so it never reaches a browser chunk. */",
        "import { isBrandHost } from './brand';",
        "",
        f"export const LEGACY_DOMAINS: readonly string[] = {ts_list(legacy)};",
        f"export const LEGACY_MEDIA_HOSTS: readonly string[] = {ts_list(['media.' + d for d in legacy])};",
        f"export const LEGACY_API_HOSTS: readonly string[] = {ts_list(['api.' + d for d in legacy])};",
        "",
        "/** True for the brand domain, any legacy domain, and any subdomain of either. */",
        "export function isBrandOrLegacyHost(host: string): boolean {",
        "  const h = host.toLowerCase();",
        "  if (isBrandHost(h)) return true;",
        "  return LEGACY_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));",
        "}",
        "",
    ]
    return "\n".join(lines)


def render_dart(b: dict) -> str:
    h, e = b["hosts"], b["emails"]
    legacy = legacy_domains(b)
    lines = [f"// {l}" for l in HEADER.splitlines()] + [""]
    lines += [
        "/// Public brand name and domain. See Specs/brand.json.",
        "abstract final class Brand {",
        f"  static const String name = {dart(b['name'])};",
        f"  static const String nameUpper = {dart(b['nameUpper'])};",
        f"  static const String nameCompact = {dart(b['nameCompact'])};",
        f"  static const String slug = {dart(b['slug'])};",
        f"  static const String nameHindi = {dart(b['nameHindi'])};",
        f"  static const String slogan = {dart(b['slogan'])};",
        f"  static const String nameMeaningShort = {dart(b.get('nameMeaningShort', ''))};",
        f"  static const String nameMeaningLong = {dart(b.get('nameMeaningLong', ''))};",
        f"  static const String domain = {dart(b['domain'])};",
        f"  static const String webOrigin = {dart('https://' + b['domain'])};",
        f"  static const String apiHost = {dart(h['api'])};",
        f"  static const String mediaHost = {dart(h['media'])};",
        f"  static const String mediaOrigin = {dart('https://' + h['media'])};",
        f"  static const String authHost = {dart(h['auth'])};",
        f"  static const String clerkPublishableKey = {dart('pk_live_' + base64.b64encode((h['auth'] + '$').encode()).decode())};",
        f"  static const String mailHost = {dart(h['mail'])};",
        "  /// Former domains. Their api./media. hosts stay attached forever.",
        f"  static const List<String> legacyDomains = {dart_list(legacy)};",
        f"  static const List<String> legacyMediaHosts = {dart_list(['media.' + d for d in legacy])};",
        f"  static const List<String> legacyApiHosts = {dart_list(['api.' + d for d in legacy])};",
        f"  static const String supportEmail = {dart(e['support'])};",
        f"  static const String noreplyEmail = {dart(e['noreply'])};",
        f"  static const String helloEmail = {dart(e['hello'])};",
        "  /// PERMANENT — a Play package id can never change.",
        f"  static const String playPackageId = {dart(b['playPackageId'])};",
        "",
        "  /// Absolute URL on the public website.",
        "  static String url([String path = '/']) =>",
        "      webOrigin + (path.startsWith('/') ? path : '/$path');",
        "",
        "  /// True for the brand domain and any subdomain of it.",
        "  static bool isBrandHost(String host) {",
        "    final h = host.toLowerCase();",
        "    return h == domain || h.endsWith('.$domain');",
        "  }",
        "",
        "  /// True for the brand domain, any legacy domain, and subdomains of either.",
        "  static bool isBrandOrLegacyHost(String host) {",
        "    final h = host.toLowerCase();",
        "    if (isBrandHost(h)) return true;",
        "    return legacyDomains.any((d) => h == d || h.endsWith('.$d'));",
        "  }",
        "}",
        "",
    ]
    return "\n".join(lines)


def sync_wrangler(text: str, b: dict) -> str:
    """[SAATHUM-BRAND-CENTRAL-WORKER-1] Rewrite ONLY the brand-derived values in the
    top-level (production) block of worker/wrangler.toml. Everything from the first
    `[env.` table onward (staging), every comment and the avatok.ai routes are left
    byte-for-byte alone."""
    h = b["hosts"]
    m = re.search(r"^\[env\.", text, re.M)
    cut = m.start() if m else len(text)
    prod, rest = text[:cut], text[cut:]

    def setval(src: str, key: str, value: str) -> str:
        # KEY = "value"   (anything after the closing quote, e.g. a comment, is kept)
        return re.sub(r'^(%s\s*=\s*")[^"]*(")' % re.escape(key),
                      lambda mm: mm.group(1) + value + mm.group(2), src, flags=re.M)

    def setorigin(src: str, key: str, origin: str) -> str:
        # KEY = "https://host/path"  -> only the scheme+host part changes
        return re.sub(r'^(%s\s*=\s*")https?://[^/"]+' % re.escape(key),
                      lambda mm: mm.group(1) + origin, src, flags=re.M)

    web = "https://" + b["domain"]
    prod = setval(prod, "WEB_BASE_URL", web)
    prod = setorigin(prod, "WALLET_RETURN_URL", web)
    prod = setval(prod, "BLOSSOM_BASE_URL", "https://" + h["media"])
    prod = setorigin(prod, "CLERK_JWKS_URL", "https://" + h["auth"])
    prod = setval(prod, "CLERK_ISSUER", "https://" + h["auth"])
    prod = setval(prod, "PLAY_PACKAGE_ID", b["playPackageId"])
    # [SAATHUM-DOMAIN-LEGACY-1] The brand's API routes = every non-avatok.ai
    # `[[routes]] pattern = "..." custom_domain = true` block in the prod section:
    # one for the current api host AND one api.<legacy> per legacy domain (those stay
    # attached forever). The first such block is replaced by the full generated set,
    # any further ones (previous generator runs) are dropped, so this is idempotent.
    hosts = list(dict.fromkeys([h["api"]] + ["api." + d for d in legacy_domains(b)]))
    generated = "\n".join(
        f'[[routes]]\npattern = "{x}"\ncustom_domain = true\n' for x in hosts)
    route_re = re.compile(
        r'\[\[routes\]\]\npattern = "(?![^"]*avatok\.ai")[^"]*"\ncustom_domain = true\n'
        r'(?:\n(?=\[\[routes\]\]\npattern = "(?![^"]*avatok\.ai")))?')
    seen = []

    def route_sub(mm):
        if seen:
            return ""
        seen.append(1)
        return generated

    prod = route_re.sub(route_sub, prod)
    if not seen:
        sys.exit("gen_brand: worker/wrangler.toml prod block has no brand [[routes]] block to rewrite")
    return prod + rest


def sync_consumers_wrangler(text: str, b: dict) -> str:
    """[SAATHUM-BRAND-CENTRAL-GUARD-1] consumers/wrangler.toml production block only:
    EMAIL_FROM_DEFAULT = "<emailFromName> Support <noreply mailbox>". Staging untouched."""
    m = re.search(r"^\[env\.", text, re.M)
    cut = m.start() if m else len(text)
    prod, rest = text[:cut], text[cut:]
    value = f'{b["emailFromName"]} Support <{b["emails"]["noreply"]}>'
    prod = re.sub(r'^(EMAIL_FROM_DEFAULT\s*=\s*")[^"]*(")',
                  lambda mm: mm.group(1) + value + mm.group(2), prod, flags=re.M)
    return prod + rest


def main() -> int:
    check = "--check" in sys.argv[1:]
    b = load()
    outputs = {p: render_ts(b, client=(p == WEB_TARGET)) for p in TS_TARGETS}
    outputs[WEB_LEGACY_TARGET] = render_legacy_ts(b)
    outputs[DART_TARGET] = render_dart(b)
    if WRANGLER_TARGET.exists():
        outputs[WRANGLER_TARGET] = sync_wrangler(WRANGLER_TARGET.read_text(encoding="utf-8"), b)
    if CONSUMERS_WRANGLER.exists():
        outputs[CONSUMERS_WRANGLER] = sync_consumers_wrangler(CONSUMERS_WRANGLER.read_text(encoding="utf-8"), b)
    stale = []
    for path, text in outputs.items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == text:
            continue
        if check:
            stale.append(path.relative_to(ROOT))
        else:
            path.write_text(text, encoding="utf-8")
            print(f"wrote {path.relative_to(ROOT)}")
    if check:
        if stale:
            print("STALE — re-run `python3 scripts/gen_brand.py`:")
            for p in stale:
                print(f"  {p}")
            return 1
        print("gen_brand: all brand mirrors match Specs/brand.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
