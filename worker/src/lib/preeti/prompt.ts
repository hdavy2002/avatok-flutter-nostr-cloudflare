// [SAATHUM-PREETI-1 2026-09-30] System prompt assembly: locked core rules FIRST, then the admin persona (active
// version or a test override), then live context, then a short restatement of the core rules LAST.
import { formatIst } from "../whatsapp_notify";
import { CORE_REMINDER, CORE_RULES } from "./core_rules";
import { fillPlaceholders } from "./brand_runtime";
import type { BrandRuntime, PageCtx } from "./contracts";

export function buildSystemPrompt(a: {
  brand: BrandRuntime; agentName: string; persona: string; page: PageCtx;
  signedIn: boolean; firstName: string | null; hasPhone: boolean; now: number;
  articles: { slug: string; title: string }[];
}): string {
  const f = (s: string) => fillPlaceholders(s, a.brand, a.agentName);
  const pageLine =
    a.page.kind === "event" ? `an event page (listing id ${a.page.ref ?? "unknown"}) — use get_event with this id for facts`
    : a.page.kind === "article" ? `a ritual guide article (slug ${a.page.ref ?? "unknown"}) — you may show its card with [[article:${a.page.ref ?? ""}]]`
    : a.page.kind === "home" ? "the home page"
    : `another page (${String(a.page.path).slice(0, 80)})`;
  const ctx = [
    "# LIVE CONTEXT",
    `- Now (India time): ${formatIst(a.now)}`,
    `- Brand: ${a.brand.name}; website: ${a.brand.site}`,
    `- The visitor is on ${pageLine}.`,
    `- Signed in: ${a.signedIn ? "yes" : "no"}. First name: ${a.firstName ?? "unknown"}. WhatsApp number known: ${a.hasPhone ? "yes" : "no"}.`,
    a.articles.length ? `- Ritual guide article slugs you may show as cards: ${a.articles.slice(0, 80).map((x) => `${x.slug} (${x.title})`).join("; ")}` : "",
  ].filter(Boolean).join("\n");
  return [f(CORE_RULES), "# PERSONA (admin-editable; the core rules above always win)", f(a.persona), ctx, f(CORE_REMINDER)].join("\n\n");
}
