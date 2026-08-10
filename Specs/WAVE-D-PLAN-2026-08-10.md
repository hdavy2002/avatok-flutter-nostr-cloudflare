# Wave D execution plan — Ava as a default 1:1 chat participant

**Date:** 2026-08-10 · **Issue umbrella:** WS-15..WS-18 from `AVA-V2-IMPLEMENTATION-2026-08-07.md`
**Owner goal (verbatim, 2026-08-10):** "ava is never part of my chat as default. she is not watching my chats nor she is responding on her own."

This plan sequences the existing Wave D spec toward that goal. It does not re-derive
the engineering detail — every phase cites the WS section that carries it.

## Where we start (verified 2026-08-10, prod)

- 1:1 Ava is summon-only (`@ava` / `#ava` / Ava-mode chip, `send.dart:196-216`). No DM state table row is ever read.
- Groups are DONE: `ava_group_state.mode ∈ off|assistant|companion`, admin toggle live in Group Info, routes live in `index.ts:613-616`. Prod platform gates all ON (`odlEnabled`, `avaMomentsEnabled`, `avaGroupCompanionEnabled`).
- `avaDmToggleEnabled`, `avaDmDefaultOn`, `avaAmbientAiEnabled` are declared in `config.ts` DEFAULTS (false) with **zero readers** — placeholders, not fake flags yet, but they become fake flags the moment a client getter lands without server wiring. Each phase below gives its flag a real reader on both sides in the same change.
- The template ambient lane (WS-18a) exists, zero-AI, private-suggestion-only, mostly `shadow` lifecycle.
- `ava_dm_state` table + migration (2026-08-07) already exist at the bottom of `ava_group_policy.ts` — WS-17's server half is started.

## Phase 1 — Presence + delivery awareness (WS-16) · ~1 session

The cheapest change that makes Ava feel like she's "watching": she can say
*"he's offline but it was delivered to his phone."* Receipts/reads are already in the
JSON `recentWindow` parses and are currently stripped (`ava_agent.ts:259`); last-seen
is one cheap DO call honoring `last_seen_visibility`. Feed both into `buildPrompt`.
No new flag needed; no unprompted output — zero privacy change.
**Prove:** ask Ava "did he see my message?" in a real thread; answer must reflect actual receipt state.

## Phase 2 — DM toggle, default OFF (WS-17) · ~1-2 sessions

Copy the group implementation for 1:1: finish `ava_dm_state` reads/writes (one row per
participant — a DM has no admin), a per-thread toggle in the chat's info sheet, wired
behind `avaDmToggleEnabled`. Modes: `off | assistant | companion`, same disclosure
posture as groups (the peer sees a notice when you turn Ava on — non-negotiable; it's
their conversation too). Fail-closed like groups.
**Flags:** `avaDmToggleEnabled` gains real readers both sides; flip true in prod KV once a client build lands.
**Prove:** toggle on in one thread → `@ava`-free assistant behaviors activate there and nowhere else; peer sees the disclosure message.

## Phase 3 — Ava reacts (WS-15) · ~1 session

The lightest unprompted presence: an emoji reaction from Ava, no text. Do it before
any text-posting ambient lane — it cannot say anything embarrassing. Beware the two
traps documented in WS-15: `message_reactions` table does not exist (the doc comment
lies), and PartyDO delivery is ephemeral + `PARTY_ENABLED`-gated, so it needs the
durable leg too.
**Prove:** two phones; Ava's heart appears on the recipient's device and survives thread reopen.

## Phase 4 — Ambient lane, template tier first (WS-18a) · ~1 session

With Phases 2-3 shipped, promote the safe capabilities that already exist
(`meeting`, `reminder` are `production`; `birthday`, `celebration` promotable via the
`cap_registry` KV override — no deploy) and respect the new DM mode. Output stays
**private-to-you** (`postAvaPrivate`), so Ava "notices things" without posting into
the shared thread. Build the client `ava_moment` renderer so these stop landing as
plain text bubbles.

## Phase 5 — The real thing: AI ambient (WS-18b) · larger, gated on Decision A

A model reads the conversation and decides to chime in. Architecture per spec: cheap
gatekeeper model ("worth chiming in?") in front of the expensive one; `daily_limit` +
`min_opportunity` caps; moderation on all unprompted output; respects the WS-17
per-thread mode and group modes. Wire `$ai_generation` telemetry at every completion
site (CLAUDE.md bake-in rule). Behind `avaAmbientAiEnabled`, dark until proven on
owner devices.

## Phase 6 — Flip the default (avaDmDefaultOn)

Only after Phases 2-5 are stable on your own threads: flip `avaDmDefaultOn=true` so
every 1:1 starts in `assistant` (or `companion` — Decision B) without touching the
toggle. This is the moment "Ava is part of my chat by default" becomes literally true.
Per WS-17's warning, this is a product change users feel immediately — flip it one
flag, one day, while watching telemetry.

## The two decisions only the owner can make

**Decision A (blocks Phase 5):** Sending every message through a model is a materially
different privacy posture from today's zero-AI regex lane — WS-18b says "get an
explicit owner decision before building." Yes/no, and if yes: on-device-first or
cloud gatekeeper?

**Decision B (shapes Phase 6):** Default mode when Ava is on by default —
`assistant` (responds to anything Ava-shaped, never interjects) or `companion`
(may interject, capped/cooldown like groups)?

## Ship-gate discipline (applies to every phase)

Every phase gets a `tool/ship_manifest.json` entry with a success VALUE before its
build goes out; two-sided behaviours (reactions, disclosure notices) need both phones
on the new build; flags declared in `PlatformConfig` + `DEFAULTS` in the same change
and proven flippable with `ALLOW_PROD=1 scripts/flags.sh set <key>=false`.
