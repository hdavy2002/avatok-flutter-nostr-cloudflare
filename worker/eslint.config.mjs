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

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser, parserOptions: { sourceType: "module" } },
    rules: { "no-restricted-syntax": ["error", ...restricted] },
  },
  {
    // The gateway is the ONE place provider access is allowed (core + adapters).
    files: ["src/lib/ava_reason/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
