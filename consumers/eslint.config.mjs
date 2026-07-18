// eslint.config.mjs — One Brain gateway enforcement (consumers package, SPEC §4, B1).
//
// THE ONE RULE: no code may reach an AI provider except through the avaReason
// gateway. In the consumers package the gateway seam is the shim
// consumers/src/ava_reason.ts (it imports the SHARED core from
// worker/src/lib/ava_reason/, which lives outside this package's src/ and so is
// never linted here). This bans, everywhere in src/ EXCEPT that shim:
//   (a) direct `fetch` to a provider host (openrouter.ai, Google generativelanguage,
//       api.openai.com, api.x.ai);
//   (b) bare `env.AI.run` / `.AI.run` — route Workers-AI via avaReason().
// Without this, v1's provider bypasses regrow (SPEC §4).
//
// NOT installed in-task (B1 forbids `npm install`/`npm run` here). Dev deps are
// declared in package.json; enforce with `npm install && npm run lint`. Rules use the
// CORE ESLint `no-restricted-syntax` (no plugin) — only the TS PARSER is needed.
import tseslint from "typescript-eslint";

const PROVIDER_HOSTS = [
  "openrouter\\.ai",
  "generativelanguage\\.googleapis\\.com",
  "api\\.openai\\.com",
  "api\\.x\\.ai",
];

const AI_RUN_MSG =
  "Bare env.AI.run is banned outside consumers/src/ava_reason.ts. Route Workers-AI through " +
  "avaReason() (consumers/src/ava_reason.ts → shared worker/src/lib/ava_reason core) so the call " +
  "gains unified telemetry, spend tracking and the kill-switch seam. One Brain B1, SPEC §4.";
const FETCH_MSG =
  "Direct fetch to an AI provider host is banned outside consumers/src/ava_reason.ts. Route via " +
  "avaReason (shared ava_reason adapters). One Brain B1, SPEC §4.";

const restricted = [
  { selector: "CallExpression[callee.property.name='run'][callee.object.property.name='AI']", message: AI_RUN_MSG },
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
    // The consumers gateway seam — the ONE place provider access is allowed here.
    files: ["src/ava_reason.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
