#!/usr/bin/env node
// [AI-FLAG-CONTRACT-1] Config-contract CI gate.
//
// CLAUDE.md ("FAKE FLAGS"): "A flag the client reads but config.ts does not
// declare is a FAKE flag." `inAppUpdateEnabled` shipped exactly this way on
// 2026-07-15 (a documented brake on auto-installing updates that could not
// actually be pulled), and ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25 §18
// found TWO more live in production the same way: `imageGenEnabled` (client
// key) vs `generativeEnabled` (the Worker's real key) and `aiVoiceCallEnabled`
// (declared nowhere server-side despite a docstring instructing a KV flip).
// Both are fixed in this same commit — this script is the PERMANENT fix so the
// next one is caught by CI instead of discovered in production. See §18/§54.
//
// It extracts:
//   1. every flag key the Flutter client reads off RemoteConfig (`_b`/`_n`/
//      `_s`/`_cfg[...]` forms in app/lib/core/remote_config.dart);
//   2. the Worker's `PlatformConfig` interface, `DEFAULTS` object and
//      `numericKeys` Set (worker/src/routes/config.ts) — the single source of
//      truth `putConfig`/`readConfig` actually enforce.
//
// ...and FAILS (exit 1) when:
//   (a) a client-read key is absent from `DEFAULTS`               — FAKE FLAG
//       (the client believes it can be toggled; `putConfig` 400s `unknown key`
//        on any attempt, so the client's fallback is its permanent value)
//   (b) a numeric-typed `DEFAULTS` key is missing from `numericKeys`  — NUMERIC-BROKEN
//       (`putConfig` 400s `bad type` on any attempt to actually tune it)
//   (c) a key in CRITICAL_SOURCE_READER_KEYS is declared+settable but read
//       NOWHERE in worker/src or app/lib                            — ORPHAN
//       (writable, but flipping it does nothing — the exact `imageDailyCap`
//        bug §18 found: in numericKeys, but read by nothing)
//   (d) worker/src reads a config key (`readConfig(env).someKey`, a variable
//       bound from `readConfig(env)`/`cfgSafe(env)` dotted elsewhere in the
//       same file, or the `(... as any).someKey` escape hatch) that is absent
//       from `DEFAULTS`/`PlatformConfig`                          — WORKER_FAKE_FLAG
//       (this is (a)'s server-side twin — gate finding B3, 2026-07-25:
//        `unrecoveredPlatformAlertMicroUsd` was read in worker/src/lib/ai_billing.ts
//        through an `as any` cast specifically BECAUSE config.ts never declared
//        it, so `putConfig` 400'd `unknown key` on any attempt to set it and the
//        edge-triggered platform alert was permanently dead code — introduced by
//        the very wave meant to eliminate this failure mode. An `as any` cast on
//        a config-shaped value is itself the tell and is flagged even when the
//        key IS declared, since it means the type system was routed around to
//        read it.)
//
// No dependencies beyond node:fs / node:path — runs anywhere Node 18+ runs,
// including CI with no `npm ci` step.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const REMOTE_CONFIG_PATH = path.join(ROOT, "app/lib/core/remote_config.dart");
const CONFIG_TS_PATH = path.join(ROOT, "worker/src/routes/config.ts");
const APP_LIB_DIR = path.join(ROOT, "app/lib");
const WORKER_SRC_DIR = path.join(ROOT, "worker/src");

// ---------------------------------------------------------------------------
// Allowlists — every entry MUST carry a comment. A growing allowlist is a
// sign the contract is being routed around, not honoured; keep these short.
// ---------------------------------------------------------------------------

// Keys the Flutter client reads via RemoteConfig's `_b`/`_n`/`_s`/`_cfg[...]`
// forms that are DELIBERATELY not mirrored in the Worker's PlatformConfig/
// DEFAULTS — i.e. genuinely client-local values, never fetched from
// /api/config. Empty today: every key RemoteConfig reads comes off the server
// blob. Add an entry here ONLY with a comment proving the key is intentionally
// local-only — otherwise a client-read key with no server DEFAULTS entry is
// exactly the `inAppUpdateEnabled` / `imageGenEnabled` fake-flag bug this
// script exists to catch, and allowlisting it would just hide the bug.
const CLIENT_ONLY_ALLOWLIST = new Set([
  // (none — keep it that way)
]);

// PlatformConfig/DEFAULTS keys that are legitimately SERVER-ONLY flags: real,
// flippable KV switches with no Flutter mirror because they gate
// server-internal behaviour (cost/telemetry/billing internals), not a
// client-visible surface. Exempts a key from the "no reader in app/lib" half
// of the source-reader assertion below — it must still be read somewhere in
// worker/src, or it is an orphan, not "server-only".
const SERVER_ONLY_ALLOWLIST = new Set([
  // [AI-BILLING-CORE-1] internal billing-gate rollout switch (ai_billing.ts);
  // deliberately no client UI surface — the client never needs to know
  // whether wallet metering is live server-side.
  "aiWalletMeteringEnabled",
]);

// Curated set of critical gates/caps that MUST have a real source reader
// somewhere (worker/src or app/lib), not just a DEFAULTS/numericKeys entry.
// This is deliberately NOT every key in DEFAULTS: ROOT-CAUSE-REPORT §18 also
// found a handful of PRE-EXISTING orphans outside this issue's scope
// (`callProtocolVersion`, `companionEnabled`, `ivrAiFrontDesk`,
// `networkReconnectWindowSec`, `offlineDetectSec`, `escrowPromptTimeoutSec`,
// the `campaign*` sub-knobs) — enforcing this assertion against ALL of them
// here would fail CI for issues [AI-FLAG-CONTRACT-1] did not touch. Extend
// this list deliberately, one issue at a time, as each of those gets wired or
// removed — don't make it universal in one shot.
const CRITICAL_SOURCE_READER_KEYS = [
  "generativeEnabled", // [AI-FLAG-CONTRACT-1] the renamed real image-gen gate
  "imageDailyCap", // [AI-FLAG-CONTRACT-1] the emergency image-gen circuit breaker
  "aiWalletMeteringEnabled", // [AI-BILLING-CORE-1] wallet-metering rollout switch
];

// Keys the worker-side scan below (extractWorkerConfigKeys) flags as read off
// a config-shaped value but that are DELIBERATELY not real PlatformConfig
// keys — i.e. the property name collides with something else entirely (a
// different object that also happens to be assigned to a variable named
// `cfg`/`config`, or a `.then` chain on an unrelated promise). Add an entry
// ONLY with a comment proving it's a false positive, not a real gap — an
// undeclared key that genuinely comes off readConfig()/cfgSafe() is exactly
// the bug this half of the script exists to catch (gate finding B3).
const WORKER_KEY_FALSE_POSITIVE_ALLOWLIST = new Set([
  // worker/src/routes/messaging.ts:301-312 — `const cfg = await
  // readAutoResponderConfig(env, args.recipient)` (a per-RECIPIENT
  // auto-responder settings row, unrelated to PlatformConfig) reuses the
  // variable name `cfg` that other functions in the SAME FILE bind from the
  // real `readConfig(env)`. This script's worker-side scan is file-scoped,
  // not function-scoped (regex, no AST — see extractWorkerConfigKeys), so it
  // can't tell the two `cfg`s apart. `audience` is a real field on the
  // auto-responder row, not a PlatformConfig key.
  "audience",
  // worker/src/routes/ava_guardian.ts:891 binds `const c = await
  // readConfig(env)`, but `c` is also used file-wide as a generic one-letter
  // closure/reduce parameter unrelated to config — e.g. line 650
  // `s.some((c) => ks.some((k) => c.includes(k)))` (`c` = a category string)
  // and lines 1217-1218 `children.reduce((s, c) => s + c.total, 0)` /
  // `... s + c.highSeverity, 0)` (`c` = a child-summary object). Same
  // file-scope limitation as `audience` above — `includes`/`total`/
  // `highSeverity` are not PlatformConfig keys.
  "includes",
  "total",
  "highSeverity",
]);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readText(p) {
  return readFileSync(p, "utf8");
}

function listFilesRecursive(dir, extensions) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, extensions));
    } else if (extensions.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// config.ts documents flags with `// [TAG-1] ...` comments, several of which
// contain a literal `[`/`]` (issue-tag brackets) or `{`/`}` (inline JSON
// snippets, e.g. `{ok:true, disabled:true}`) INSIDE the comment text. A naive
// character-by-character brace/bracket counter run over the raw source would
// count those too and could close a block early (or hunt for a close that
// isn't really there). Replace comment bodies with spaces first — same
// string length, so every index computed against the cleaned copy still
// lines up with the original `src` for the final slice. Not a real
// tokenizer (no string-literal awareness), but this file has no `//` inside
// a string literal in the regions this script slices, and is adequate for a
// CI tripwire.
function stripLineCommentsPreservingLength(src) {
  let out = "";
  let inComment = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!inComment && ch === "/" && src[i + 1] === "/") inComment = true;
    if (ch === "\n") {
      inComment = false;
      out += ch;
      continue;
    }
    out += inComment ? " " : ch;
  }
  return out;
}

// Return the substring between the FIRST `openChar` at/after `marker`'s start
// and its matching `closeChar`, tracking nesting depth so inner `{}`/`[]`
// pairs (nested literals) don't terminate the slice early. Depth-counts
// against a comment-stripped copy (see above) but slices the ORIGINAL `src`,
// so the returned text still has its comments intact for the value-parsing
// regexes downstream.
function sliceBalancedBlock(src, marker, openChar, closeChar) {
  const clean = stripLineCommentsPreservingLength(src);
  const markerIdx = clean.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`check-config-contract: marker not found in source: ${JSON.stringify(marker)}`);
  }
  const openIdx = clean.indexOf(openChar, markerIdx);
  if (openIdx === -1) {
    throw new Error(`check-config-contract: no '${openChar}' found after marker ${JSON.stringify(marker)}`);
  }
  let depth = 0;
  for (let i = openIdx; i < clean.length; i++) {
    if (clean[i] === openChar) depth++;
    else if (clean[i] === closeChar) {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  throw new Error(`check-config-contract: unterminated block for marker ${JSON.stringify(marker)}`);
}

// ---------------------------------------------------------------------------
// Extraction — client side
// ---------------------------------------------------------------------------

function extractClientKeys(dartSrc) {
  const keys = new Set();
  const patterns = [
    /_b\(\s*'([A-Za-z0-9_]+)'/g, // bool getters:   _b('key', default)
    /_n\(\s*'([A-Za-z0-9_]+)'/g, // numeric getters: _n('key', default) (not yet used, future-proofed)
    /_s\(\s*'([A-Za-z0-9_]+)'/g, // string getters:  _s('key', default) (not yet used, future-proofed)
    /_cfg\[\s*'([A-Za-z0-9_]+)'\s*\]/g, // raw access:  _cfg['key'] (incl. inside _asNum(...))
  ];
  for (const re of patterns) {
    for (const m of dartSrc.matchAll(re)) keys.add(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Extraction — worker side
// ---------------------------------------------------------------------------

function extractInterfaceKeys(tsSrc) {
  const body = sliceBalancedBlock(tsSrc, "export interface PlatformConfig", "{", "}");
  const keys = new Map(); // key -> declared type
  const re = /^\s*([A-Za-z0-9_]+)\s*:\s*(boolean|number|string)\s*;/gm;
  for (const m of body.matchAll(re)) keys.set(m[1], m[2]);
  return keys;
}

function classifyDefaultValue(rawValue) {
  const v = rawValue.trim();
  if (v === "true" || v === "false") return "boolean";
  if (/^-?[\d_]+(\.\d+)?$/.test(v)) return "number";
  if (/^["'].*["']$/.test(v)) return "string";
  return `unknown(${v})`;
}

function extractDefaults(tsSrc) {
  const body = sliceBalancedBlock(tsSrc, "const DEFAULTS: PlatformConfig = ", "{", "}");
  const entries = new Map(); // key -> 'boolean' | 'number' | 'string' | 'unknown(...)'
  const re = /^\s*([A-Za-z0-9_]+)\s*:\s*([^,\n]+?),?\s*(?:\/\/.*)?$/gm;
  for (const m of body.matchAll(re)) {
    entries.set(m[1], classifyDefaultValue(m[2]));
  }
  return entries;
}

function extractNumericKeys(tsSrc) {
  const body = sliceBalancedBlock(tsSrc, "const numericKeys = new Set([", "[", "]");
  const keys = new Set();
  // config.ts uses double-quoted string literals throughout — match either
  // quote style so this doesn't silently break if that convention drifts.
  const re = /["']([A-Za-z0-9_]+)["']/g;
  for (const m of body.matchAll(re)) keys.add(m[1]);
  return keys;
}

// ---------------------------------------------------------------------------
// Source-reader assertion
// ---------------------------------------------------------------------------

// Heuristic: a "real read" is a dot-prefixed identifier occurrence of the key
// (`cfg.imageDailyCap`, `RemoteConfig.generativeEnabled`, ...) anywhere in the
// given file set. It is intentionally simple (no AST, no comment-stripping) —
// this is a CI tripwire, not a full analyzer; a flagged key still needs a
// human look, but a key that trips this check with ZERO occurrences anywhere
// is unambiguously an orphan (source-reader count of exactly 0 cannot be a
// false negative caused by comment noise, since comments would only ever
// ADD false-positive matches, never hide a real one).
function countDotPrefixedOccurrences(files, key) {
  const re = new RegExp(`\\.${key}\\b`, "g");
  let count = 0;
  for (const f of files) {
    const text = readText(f);
    const m = text.match(re);
    if (m) count += m.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Extraction — worker-side config READS (not just the DEFAULTS declaration).
// This is the (d) half of the contract: a key can be perfectly declared in
// PlatformConfig/DEFAULTS/numericKeys (satisfying (a)/(b)) and STILL be a
// fake flag if the code that reads it never went through readConfig()'s
// typed return at all — an `as any` cast bypasses the compiler check that
// would otherwise catch a typo or an undeclared key at build time. Gate
// finding B3 was exactly this: `unrecoveredPlatformAlertMicroUsd` was read
// via `((await readConfig(env)) as any).unrecoveredPlatformAlertMicroUsd`
// specifically because it was NOT declared — the cast is what let the
// undeclared read compile.
//
// Three shapes are matched, heuristically (regex, no AST — same tradeoff as
// countDotPrefixedOccurrences above; false positives go in
// WORKER_KEY_FALSE_POSITIVE_ALLOWLIST with a comment, false negatives are
// still better than the zero coverage this half of the file had before):
//   1. Direct chain off a `readConfig(env)` call, with or without an
//      `as any` escape hatch and/or an extra wrapping paren:
//        (await readConfig(env)).someKey
//        ((await readConfig(env)) as any).someKey
//        readConfig(env).someKey
//   2. `.then((c) => c.someKey)` off a `readConfig(env)` call.
//   3. A variable bound from `readConfig(env)`/`cfgSafe(env)` (the
//      brain_media.ts-style wrapper that returns readConfig()'s result under
//      a locally-named type), then dotted elsewhere in the same file —
//      `const cfg = await readConfig(env); ... cfg.someKey` — INCLUDING that
//      variable's own `(cfg as any).someKey` escape hatch.
// Promise/control-flow methods, not property reads — chaining `.then`/`.catch`/
// `.finally` directly off `readConfig(env)` (or a bound config variable, though
// that would be unusual since by then it's already resolved) must never be
// recorded as a "key". `.then` is also handled specially by shape #2 below.
const PROMISE_METHOD_NAMES = new Set(["then", "catch", "finally"]);

function extractWorkerConfigKeys(workerFiles) {
  const found = new Map(); // key -> Set<file>
  const record = (key, file) => {
    if (PROMISE_METHOD_NAMES.has(key)) return;
    if (!found.has(key)) found.set(key, new Set());
    found.get(key).add(file);
  };

  // Wrapper function names known to return a readConfig(env)-shaped value.
  // Extend this if a new wrapper appears (e.g. routes/brain_media.ts's
  // cfgSafe, which returns `(await readConfig(env)) as unknown as Cfg`).
  const CONFIG_SOURCE_FNS = ["readConfig", "cfgSafe"];
  const sourceFnAlt = CONFIG_SOURCE_FNS.join("|");

  for (const file of workerFiles) {
    // Comment-stripped so prose like "...makes both a no-op in beta.\n  listing_post: 100,"
    // (a sentence ending in "beta." immediately above an unrelated object-literal
    // key) can't be misread as a `beta.listing_post` property access. Same length
    // as the original, so this is safe to run the byte-offset-based regexes below
    // against directly — no need to re-slice against `src`, unlike
    // sliceBalancedBlock's usage of this helper.
    const src = stripLineCommentsPreservingLength(readText(file));

    // 1. Direct chain, with any mix of wrapping parens and an `as any` escape
    //    hatch in between — e.g. `(await readConfig(env)).foo`,
    //    `((await readConfig(env)) as any).foo` (a closing paren BEFORE "as
    //    any", then another AFTER it — this exact shape is what gate finding
    //    B3 looked like in ai_billing.ts), or the plain `readConfig(env).foo`.
    //    `(?:\s*\)|\s*as\s*any)*` accepts any order/count of those two tokens
    //    so it doesn't matter which side of the cast the extra paren lands on.
    const chainRe = new RegExp(`(?:${sourceFnAlt})\\(env\\)(?:\\s*\\)|\\s*as\\s*any)*\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
    for (const m of src.matchAll(chainRe)) record(m[1], file);

    // 2. `.then((c) => c.someKey)` chains.
    const thenRe = new RegExp(`(?:${sourceFnAlt})\\(env\\)\\.then\\(\\s*\\(?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)?\\s*=>\\s*\\1\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
    for (const m of src.matchAll(thenRe)) record(m[2], file);

    // 3. Variables bound from a config-source call, then dotted (or `as any`
    //    cast+dotted) anywhere else in the same file.
    const bindRe = new RegExp(`(?:const|let)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(?:await\\s+)?(?:${sourceFnAlt})\\(env\\)`, "g");
    const boundVars = new Set();
    for (const m of src.matchAll(bindRe)) boundVars.add(m[1]);
    for (const name of boundVars) {
      const useRe = new RegExp(`\\b${name}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
      for (const m of src.matchAll(useRe)) record(m[1], file);
      const castRe = new RegExp(`\\(\\s*${name}\\s*as\\s*any\\s*\\)\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g");
      for (const m of src.matchAll(castRe)) record(m[1], file);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const dartSrc = readText(REMOTE_CONFIG_PATH);
  const tsSrc = readText(CONFIG_TS_PATH);

  const clientKeys = extractClientKeys(dartSrc);
  const interfaceKeys = extractInterfaceKeys(tsSrc);
  const defaults = extractDefaults(tsSrc);
  const numericKeys = extractNumericKeys(tsSrc);

  // Hoisted here (rather than down by the ORPHAN check, where this used to
  // live) so the WORKER_FAKE_FLAG scan below can reuse the same file lists.
  const workerFiles = listFilesRecursive(WORKER_SRC_DIR, [".ts"]).filter((f) => f !== CONFIG_TS_PATH);
  const appFiles = listFilesRecursive(APP_LIB_DIR, [".dart"]);
  const searchFiles = [...workerFiles, ...appFiles];

  const failures = [];
  const warnings = [];

  // (a) FAKE FLAG: client-read key absent from DEFAULTS.
  for (const key of [...clientKeys].sort()) {
    if (CLIENT_ONLY_ALLOWLIST.has(key)) continue;
    if (!defaults.has(key)) {
      failures.push({
        kind: "FAKE_FLAG",
        key,
        detail:
          `Client reads '${key}' (app/lib/core/remote_config.dart) but the Worker's ` +
          `DEFAULTS (worker/src/routes/config.ts) does not declare it. putConfig will ` +
          `400 'unknown key' on any attempt to set it — the client's local fallback is ` +
          `its PERMANENT value. Fix: declare '${key}' in PlatformConfig AND DEFAULTS in ` +
          `the same change (see CLAUDE.md "FAKE FLAGS"), or if it is genuinely client-only, ` +
          `add it to CLIENT_ONLY_ALLOWLIST in this script with a comment proving that.`,
      });
    }
  }

  // Sanity: DEFAULTS and the PlatformConfig interface should be 1:1 (readConfig
  // types by construction). Not one of the two REQUIRED failure conditions, but
  // a real asymmetry here means readConfig(env).<key> either won't compile or
  // silently reads `undefined` — worth a loud warning either way.
  for (const key of defaults.keys()) {
    if (!interfaceKeys.has(key)) {
      warnings.push(`DEFAULTS declares '${key}' but PlatformConfig interface does not.`);
    }
  }
  for (const key of interfaceKeys.keys()) {
    if (!defaults.has(key)) {
      warnings.push(`PlatformConfig interface declares '${key}' but DEFAULTS does not — readConfig(env).${key} is always undefined until overridden.`);
    }
  }

  // (b) NUMERIC-BROKEN: numeric-typed DEFAULTS key missing from numericKeys.
  for (const [key, type] of [...defaults.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (type === "number" && !numericKeys.has(key)) {
      failures.push({
        kind: "NUMERIC_BROKEN",
        key,
        detail:
          `'${key}' is numeric in DEFAULTS (worker/src/routes/config.ts) but missing from ` +
          `numericKeys. putConfig's type check falls through to 'typeof v !== \"boolean\"' for ` +
          `any key not in numericKeys, so 'scripts/flags.sh set ${key}=<number>' will 400 ` +
          `'bad type' — the value is declared but UN-TUNABLE. Fix: add '${key}' to the ` +
          `numericKeys Set in worker/src/routes/config.ts.`,
      });
    }
  }

  // Non-fatal note: string-typed DEFAULTS keys have the SAME "un-tunable"
  // failure mode as numeric-broken (putConfig requires typeof v === "boolean"
  // for any key not in numericKeys, which rejects strings too), but no
  // stringKeys allowlist exists yet to fix it — flagging it here as a warning
  // rather than a third failure condition, since fixing it is config.ts scope
  // this script's owner (AI-FLAG-CONTRACT-1) does not touch this wave.
  for (const [key, type] of defaults.entries()) {
    if (type === "string") {
      warnings.push(`'${key}' is string-typed in DEFAULTS; putConfig has no string-key allowlist, so it is currently UN-SETTABLE via the API (same failure mode as NUMERIC_BROKEN, for strings). Not enforced as a failure here — out of [AI-FLAG-CONTRACT-1] scope.`);
    }
  }

  // (d) WORKER_FAKE_FLAG: worker/src reads a config key that DEFAULTS doesn't
  // declare — (a)'s server-side twin, and the check that would have caught
  // gate finding B3 (`unrecoveredPlatformAlertMicroUsd` read via an `as any`
  // cast in worker/src/lib/ai_billing.ts precisely because it wasn't
  // declared). An `as any` cast on a config-shaped value is flagged even when
  // the key IS already declared, since the cast itself means the read went
  // around the type system that would otherwise catch this class of bug.
  const workerConfigUses = extractWorkerConfigKeys(workerFiles);
  for (const key of [...workerConfigUses.keys()].sort()) {
    if (WORKER_KEY_FALSE_POSITIVE_ALLOWLIST.has(key)) continue;
    if (!defaults.has(key)) {
      const files = [...workerConfigUses.get(key)].map((f) => path.relative(ROOT, f)).sort();
      failures.push({
        kind: "WORKER_FAKE_FLAG",
        key,
        detail:
          `Worker code reads '.${key}' off a readConfig(env)-shaped value (${files.join(", ")}) ` +
          `but DEFAULTS/PlatformConfig (worker/src/routes/config.ts) does not declare it. ` +
          `putConfig will 400 'unknown key' on any attempt to set it — the code's local ` +
          `fallback (its '?? <default>' or equivalent) is its PERMANENT value. Fix: declare ` +
          `'${key}' in PlatformConfig, DEFAULTS, AND numericKeys (if numeric) in the same ` +
          `change (see CLAUDE.md "FAKE FLAGS"), or if this is a false positive (the property ` +
          `name collides with something unrelated to PlatformConfig), add it to ` +
          `WORKER_KEY_FALSE_POSITIVE_ALLOWLIST in this script with a comment proving that.`,
      });
    }
  }

  // (c) ORPHAN: critical key declared+settable but read nowhere in worker/src
  // or app/lib.
  for (const key of CRITICAL_SOURCE_READER_KEYS) {
    if (!defaults.has(key)) {
      failures.push({
        kind: "ORPHAN_CONFIG_ERROR",
        key,
        detail: `'${key}' is listed in CRITICAL_SOURCE_READER_KEYS but is not even declared in DEFAULTS — fix the key name or the DEFAULTS entry.`,
      });
      continue;
    }
    const readerCount = countDotPrefixedOccurrences(searchFiles, key);
    if (readerCount === 0) {
      const exemptNote = SERVER_ONLY_ALLOWLIST.has(key)
        ? " (SERVER_ONLY_ALLOWLIST still requires a worker/src reader — none found.)"
        : "";
      failures.push({
        kind: "ORPHAN",
        key,
        detail:
          `'${key}' is declared in DEFAULTS (and settable via KV) but is read NOWHERE in ` +
          `worker/src or app/lib (zero '.${key}' occurrences outside config.ts itself). A ` +
          `writable-but-unused flag is fake in every way that matters — tuning it does ` +
          `nothing. Fix: wire a real reader, or remove the key.${exemptNote}`,
      });
    }
  }

  // ---- Report ----
  if (warnings.length) {
    console.warn("\n=== check-config-contract: warnings (non-fatal) ===");
    for (const w of warnings) console.warn(`  ! ${w}`);
  }

  if (failures.length) {
    console.error("\n=== check-config-contract: FAILED ===");
    console.error(`${failures.length} config-contract violation(s) found:\n`);
    for (const f of failures) {
      console.error(`  [${f.kind}] ${f.key}`);
      console.error(`    ${f.detail}\n`);
    }
    console.error(
      "See CLAUDE.md \"FAKE FLAGS\" and Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md §18/§54 " +
        "for the full story. This check exists so a fake flag is a CI failure, not a " +
        "production discovery.",
    );
    process.exit(1);
  }

  console.log(
    `check-config-contract: OK — ${clientKeys.size} client keys, ${defaults.size} DEFAULTS keys, ` +
      `${numericKeys.size} numericKeys, ${CRITICAL_SOURCE_READER_KEYS.length} critical keys verified.`,
  );
}

main();
