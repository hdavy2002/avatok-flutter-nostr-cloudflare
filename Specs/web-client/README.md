# avatok.ai Public Web Client — build kit (multi-session)

This folder is the complete, AI-ready plan to build the public web client. It is designed so **5 AI sessions run in parallel**, then a 6th glues + pushes. Every session is given the **same master prompt + one phase file**.

## Files
- **`PROPOSAL-PUBLIC-WEB-CLIENT-v2.md`** — the redone proposal (read first). Supersedes `Specs/PROPOSAL-PUBLIC-WEB-CLIENT.md`. §11 lists what changed and why.
- **`MASTER-PROMPT.md`** — carried in **every** session. The 10 rules, the API contract, the design tokens, the route map.
- **`PHASE-0-FOUNDATION.md`** — run **first, solo**. Scaffold + token exporter + shared kit + apiClient + Clerk + nav shell.
- **`PHASE-A…E`** — run **simultaneously** after Phase 0, each in its own session, each owning disjoint files.
- **`PHASE-Z-GLUE-AND-PUSH.md`** — run **last, solo**. The only session that commits + pushes.

## How to run it
1. **Session 1 (solo):** paste `MASTER-PROMPT.md` + `PHASE-0-FOUNDATION.md`. Let it finish, write its Graphiti episode, and **not commit**.
2. **Sessions 2–6 (in parallel):** each gets `MASTER-PROMPT.md` + one of `PHASE-A/B/C/D/E`. They never edit the same file. Each writes a Graphiti episode and **does not commit**.
3. **Session 7 (solo):** paste `MASTER-PROMPT.md` + `PHASE-Z-GLUE-AND-PUSH.md`. It reads all six episodes, integrates, builds, **commits once, pushes, deploys**.

## The two rules that keep parallel sessions safe
- **File ownership is disjoint.** Each phase lists exactly which files it may create/edit. Shared files (kit, layout, nav, config, tokens) are written only by Phase 0 and Phase Z.
- **Only Phase Z commits.** Everyone else leaves work uncommitted and logs to Graphiti (`group_id="proj_avaflutterapp"`) so Phase Z can reconstruct what happened.

## Key correction vs the old proposal
The web client uses the **actual** backend media stack — **WHEP/LL-HLS** for live (Cloudflare Stream Live), **Cloudflare Realtime SFU** (native WebRTC) for consult, **Gemini Live** for agents. **No LiveKit** in the web client (LiveKit is app group-conferencing only). Lighter bundle = faster, smoother — the whole objective.
