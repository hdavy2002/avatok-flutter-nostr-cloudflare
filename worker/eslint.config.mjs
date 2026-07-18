// eslint.config.mjs — One Brain gateway enforcement (worker package, SPEC §4, B1).
//
// THE ONE RULE: no code may reach an AI provider except through the avaReason
// gateway (worker/src/lib/ava_reason/). This bans, everywhere in src/ EXCEPT the
// gateway module itself:
//   (a) direct `fetch` to a provider host (openrouter.ai, Google generativelanguage,
//       api.openai.com, api.x.ai) — add/use an adapter under ava_reason/adapters/;
//   (b) bare `env.AI.run` / `.AI.run` — route Workers-AI via avaReason()/avaReasonRaw().
// Without this, v1's ~48 provider bypasses regrow (SPEC §4: "ESLint bans raw fetch
// to provider hosts and bare env.AI.run outside lib/ava_reason/").
//
// NOT installed in-task (B1 forbids `npm install`/`npm run` here). The dev deps are
// declared in package.json; enforce with `npm install && npm run lint`. Rules use the
// CORE ESLint `no-restricted-syntax` (no plugin) — only the TS PARSER is needed.
import tseslint from "typescript-eslint";

// Provider hostnames banned outside the gateway (regex source, dots escaped).
const PROVIDER_HOSTS = [
  "openrouter\\.ai",
  "generativelanguage\\.googleapis\\.com",
  "api\\.openai\\.com",
  "api\\.x\\.ai",
];

const AI_RUN_MSG =
  "Bare env.AI.run is banned outside worker/src/lib/ava_reason/. Route Workers-AI through " +
  "avaReason()/avaReasonRaw() (worker/src/lib/ava_reason) so the call gains aiRunOpts (AI " +
  "Gateway cost logging), unified telemetry and the kill-switch seam. One Brain B1, SPEC §4.";
const FETCH_MSG =
  "Direct fetch to an AI provider host is banned outside worker/src/lib/ava_reason/. Add or use " +
  "a provider adapter (worker/src/lib/ava_reason/adapters/) and route via avaReason. One Brain B1, SPEC §4.";

const restricted = [
  // (b) X.AI.run(...) — matches env.AI.run, this.env.AI.run, (env as any).AI.run.
  { selector: "CallExpression[callee.property.name='run'][callee.object.property.name='AI']", message: AI_RUN_MSG },
  // (a) provider hostnames in string literals AND template-string chunks.
  ...PROVIDER_HOSTS.flatMap((h) => [
    { selector: `Literal[value=/${h}/]`, message: FETCH_MSG },
    { selector: `TemplateElement[value.raw=/${h}/]`, message: FETCH_MSG },
  ]),
];

// ── §10.3 Guardian safety-store ACL (SPEC-2026-07-17 §10.3) ──────────────────
// The safety store is governed by MODULE BOUNDARY, lint-enforced — "a convention can
// rot; the lint + import-walker test cannot." Two bans, both scoped so lib/guardian/
// (and, for the reader, ava_guardian.ts) are the ONLY places that touch it:
//   (1) importing guardianContext (lib/guardian/context) — the safety reader must not
//       become general context for every Ava feature (brainRecall, Copilot, compose,
//       Connect). Allowed ONLY in lib/guardian/** and routes/ava_guardian.ts.
//   (2) a raw `INSERT INTO guardian_events` — the safety store has ONE writer,
//       guardianIngest(). Allowed ONLY in lib/guardian/**.
const GUARDIAN_CONTEXT_IMPORT_MSG =
  "guardianContext (worker/src/lib/guardian/context) is ACL'd (SPEC §10.3): the safety store is " +
  "reachable ONLY from worker/src/lib/guardian/** and worker/src/routes/ava_guardian.ts — never " +
  "brainRecall or any general Ava feature. Do not import it here.";
const GUARDIAN_EVENTS_INSERT_MSG =
  "INSERT into guardian_events is banned outside worker/src/lib/guardian/ (SPEC §10.3). The safety " +
  "store has ONE writer — guardianIngest(). Route safety events through it, not a raw INSERT.";

// no-restricted-imports patterns matching any relative path resolving to the context
// module (…/lib/guardian/context, with or without an extension).
const GUARDIAN_CONTEXT_IMPORT_PATTERNS = [
  "**/guardian/context",
  "**/guardian/context.*",
  "*/guardian/context",
];
// no-restricted-syntax selectors: a raw INSERT INTO guardian_events in a plain string
// literal OR a template-string chunk. Added to the main block, dropped for lib/guardian.
const guardianInsertRules = [
  { selector: "Literal[value=/INSERT\\s+INTO\\s+guardian_events/i]", message: GUARDIAN_EVENTS_INSERT_MSG },
  { selector: "TemplateElement[value.raw=/INSERT\\s+INTO\\s+guardian_events/i]", message: GUARDIAN_EVENTS_INSERT_MSG },
];

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser, parserOptions: { sourceType: "module" } },
    rules: {
      "no-restricted-syntax": ["error", ...restricted, ...guardianInsertRules],
      // §10.3 — ban the guardianContext import everywhere; the two override blocks
      // below re-allow it inside the ACL boundary.
      "no-restricted-imports": ["error", { patterns: [
        { group: GUARDIAN_CONTEXT_IMPORT_PATTERNS, message: GUARDIAN_CONTEXT_IMPORT_MSG },
      ] }],
    },
  },
  {
    // The gateway is the ONE place provider access is allowed (core + adapters).
    files: ["src/lib/ava_reason/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // §10.3 — lib/guardian/ is the safety store's writer + reader: it may INSERT into
    // guardian_events AND import guardianContext. The AI-provider bans still apply.
    files: ["src/lib/guardian/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...restricted],
      "no-restricted-imports": "off",
    },
  },
  {
    // §10.3 — the Guardian route is the ONE purpose-scoped consumer allowed to read
    // the safety store (guardianContext). It never INSERTs directly (that ban stays on).
    files: ["src/routes/ava_guardian.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
