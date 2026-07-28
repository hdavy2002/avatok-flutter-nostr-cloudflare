// [DYNW-CORE-1] Phase 0 acceptance battery for Dynamic Workers
// (Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md §2.4). Staging tool: admin-only,
// dark behind dynamicWorkersEnabled, and touches only synthetic test ids
// (uid "dynw-test-user", KV prefixes "dynw-a"/"dynw-b", area "acceptance").
//
// POST /api/admin/dynw/acceptance → JSON report; "pass": true only when EVERY
// check (incl. all fail-closed denials) behaved as required.
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { runDynamic } from "../lib/dynw/host";
import { saveModule, setStatus, loadActive } from "../lib/dynw/registry";
import { readConfig } from "./config";

const TEST_UID = "dynw-test-user";

type Check = { name: string; pass: boolean; detail?: string };

// Dynamic-worker source used by several checks. Plain default handler dispatching
// POST /<method> (see lib/dynw/host.ts calling convention): `run` echoes; `egress`
// attempts a network call (must throw); `kv`/`brain` exercise capability stubs.
const PROBE_SRC = `
export default {
  async fetch(req, env) {
    const method = new URL(req.url).pathname.slice(1);
    let input = null; try { input = await req.json(); } catch {}
    try {
      let out;
      if (method === "run") {
        out = "hello:" + String(input);
      } else if (method === "egress") {
        const r = await fetch("https://example.com/");
        out = "UNEXPECTED_NETWORK_OK:" + r.status;
      } else if (method === "kv") {
        await env.STORAGE.put("probe", "mine");
        const own = await env.STORAGE.get("probe");
        const foreign = await env.STORAGE.get("secret"); // host planted dynkv:dynw-b:secret
        out = { own, foreign };
      } else if (method === "brain") {
        const r = await env.MEMORY.search("anything", 3);
        out = "UNEXPECTED_BRAIN_OK:" + r.lines.length;
      } else if (method === "brainWrite") {
        await env.MEMORY.ingest("should not exist");
        out = "UNEXPECTED_WRITE_OK";
      } else if (method === "faketool") {
        await env.TOOLS.exec("ZZZFAKE_TOOL_X", {});
        out = "UNEXPECTED_TOOL_OK";
      } else {
        return new Response(JSON.stringify({ ok: false, err: "no method: " + method }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, out }));
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, err: String((e && e.message) || e) }), { status: 500 });
    }
  }
};
`;

export async function dynwAcceptance(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Auth: Clerk admin JWT, OR the staging-only DYNW_TEST_SECRET header so the
  // acceptance battery can run from CI/CLI. The secret is set ONLY on staging
  // (wrangler secret); where unset (prod) this path is dead and Clerk admin is
  // the only way in — and the route 403s anyway while dynamicWorkersEnabled=false.
  let adminUid: string;
  const secret = env.DYNW_TEST_SECRET;
  if (secret && req.headers.get("x-dynw-admin-secret") === secret) {
    adminUid = "dynw-ci";
  } else {
    const admin = await requireAdmin(req, env);
    if (admin instanceof Response) return admin;
    adminUid = admin.uid;
  }
  const cfg = await readConfig(env);
  if (!cfg.dynamicWorkersEnabled) return json({ error: "dynamicWorkersEnabled is off" }, 403);

  const checks: Check[] = [];
  const ck = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });
  // ctx.exports (enable_ctx_exports) — loopback stubs for our capability classes.
  const exports = (ctx as unknown as { exports: Record<string, (o: { props: unknown }) => unknown> }).exports;
  const modules = { "probe.js": PROBE_SRC };
  const base = { area: "acceptance" as const, uid: TEST_UID, modules, mainModule: "probe.js" };
  // v3: + faketool branch (same id must always mean same code — LOADER.get caches by id).
  const codeId = (n: string) => `acceptance:platform:${n}-v3`;

  // 1 — hello world, no bindings, no network.
  const hello = await runDynamic<string>(env, ctx, { ...base, codeId: codeId("hello"), input: "world" });
  ck("hello_world", hello.ok && hello.result === "hello:world", JSON.stringify(hello));

  // 2 — egress MUST be blocked (globalOutbound: null).
  const egress = await runDynamic<string>(env, ctx, { ...base, codeId: codeId("egress"), method: "egress" });
  ck("egress_blocked", !egress.ok && egress.error === "script_error", JSON.stringify(egress));

  // 3 — DynKV scope: prefix A cannot see prefix B's key.
  await env.TOKENS.put("dynkv:dynw-b:secret", "B-SECRET", { expirationTtl: 3600 });
  const kv = await runDynamic<{ own: string | null; foreign: string | null }>(env, ctx, {
    ...base, codeId: codeId("kv"), method: "kv",
    env: { STORAGE: exports.DynKV({ props: { prefix: "dynw-a" } }) },
  });
  ck("kv_scope", kv.ok === true && kv.result?.own === "mine" && kv.result?.foreign === null, JSON.stringify(kv));

  // 4 — Brain fail-closed: consent explicitly OFF for the test uid → denied.
  await env.DB_BRAIN.prepare(
    `INSERT INTO brain_consent (uid, capability, enabled, updated_at) VALUES (?1,'master',0,?2)
     ON CONFLICT(uid, capability) DO UPDATE SET enabled=0, updated_at=?2`,
  ).bind(TEST_UID, Date.now()).run();
  const brainEnv = { MEMORY: exports.DynBrain({ props: { uid: TEST_UID, guardrailCapability: "dynw_test" } }) };
  const brain = await runDynamic<string>(env, ctx, { ...base, codeId: codeId("brain"), method: "brain", env: brainEnv });
  ck("brain_consent_denied",
    !brain.ok && brain.error === "script_error" && /capability_denied/.test(brain.detail ?? ""),
    JSON.stringify(brain));

  // 5 — Brain has NO write surface: calling a nonexistent ingest() must throw.
  const bw = await runDynamic<string>(env, ctx, { ...base, codeId: codeId("brainw"), method: "brainWrite", env: brainEnv });
  ck("brain_no_write", !bw.ok && bw.error === "script_error", JSON.stringify(bw));

  // 5b — [DYNW-CODEMODE-1] DynComposio: a nonexistent tool slug is denied by the
  // catalog check before any execution (validation chain runs inside the stub).
  const cmEnv = { MEMORY: brainEnv.MEMORY, TOOLS: exports.DynComposio({ props: { uid: TEST_UID, runId: crypto.randomUUID(), budget: 2, confirmSends: true } }) };
  const ft = await runDynamic<string>(env, ctx, { ...base, codeId: codeId("faketool"), method: "faketool", env: cmEnv });
  ck("composio_unknown_tool_denied", !ft.ok && ft.error === "script_error" && /capability_denied|unknown_tool/.test(ft.detail ?? ""), JSON.stringify(ft));

  // 6 — registry: size cap, lifecycle, owner authz, sha tamper.
  const big = "//" + "x".repeat(cfg.dynModuleMaxBytes + 1);
  const tooBig = await saveModule(env, { area: "acceptance", ownerUid: TEST_UID, source: big, requesterUid: TEST_UID, requesterIsAdmin: false });
  ck("registry_size_cap", !tooBig.ok && tooBig.error === "too_large", JSON.stringify(tooBig));

  const notOwner = await saveModule(env, { area: "acceptance", ownerUid: "someone-else", source: "//a", requesterUid: TEST_UID, requesterIsAdmin: false });
  ck("registry_owner_authz", !notOwner.ok && notOwner.error === "not_owner", JSON.stringify(notOwner));

  const src = `// dynw acceptance ${Date.now()}`;
  const saved = await saveModule(env, { area: "acceptance", ownerUid: TEST_UID, source: src, requesterUid: TEST_UID, requesterIsAdmin: false });
  let lifecycleOk = false, tamperOk = false, draftBlocked = false;
  if (saved.ok) {
    draftBlocked = (await loadActive(env, saved.code_id)).ok === false; // draft must not load
    await setStatus(env, saved.code_id, "pending_review", adminUid);
    await setStatus(env, saved.code_id, "active", adminUid);
    const loaded = await loadActive(env, saved.code_id, { requesterUid: TEST_UID });
    lifecycleOk = draftBlocked && loaded.ok === true && loaded.row.source === src;
    // Simulate out-of-band tamper (test-only raw UPDATE — registry never does this).
    await env.DB_META.prepare("UPDATE dyn_modules SET source=?2 WHERE code_id=?1").bind(saved.code_id, src + "/*tampered*/").run();
    const tampered = await loadActive(env, saved.code_id, { requesterUid: TEST_UID });
    const rowAfter = await env.DB_META.prepare("SELECT status FROM dyn_modules WHERE code_id=?1").bind(saved.code_id).first<{ status: string }>();
    tamperOk = !tampered.ok && tampered.error === "sha_mismatch" && rowAfter?.status === "disabled";
  }
  ck("registry_lifecycle", lifecycleOk);
  ck("registry_sha_tamper_disables", tamperOk);

  const pass = checks.every((c) => c.pass);
  return json({ pass, checks });
}
