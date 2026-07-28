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

// Dynamic-worker source used by several checks. `run(input)` echoes; `egress`
// attempts a network call (must throw); `kv`/`brain` exercise capability stubs.
const PROBE_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Probe extends WorkerEntrypoint {
  async run(input) { return "hello:" + String(input); }
  async egress() {
    const r = await fetch("https://example.com/");
    return "UNEXPECTED_NETWORK_OK:" + r.status;
  }
  async kv() {
    await this.env.STORAGE.put("probe", "mine");
    const own = await this.env.STORAGE.get("probe");
    const foreign = await this.env.STORAGE.get("secret"); // host planted dynkv:dynw-b:secret
    return { own, foreign };
  }
  async brain() {
    const r = await this.env.MEMORY.search("anything", 3);
    return "UNEXPECTED_BRAIN_OK:" + r.lines.length;
  }
  async brainWrite() {
    await this.env.MEMORY.ingest("should not exist");
    return "UNEXPECTED_WRITE_OK";
  }
}
`;

export async function dynwAcceptance(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;
  const cfg = await readConfig(env);
  if (!cfg.dynamicWorkersEnabled) return json({ error: "dynamicWorkersEnabled is off" }, 403);

  const checks: Check[] = [];
  const ck = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });
  // ctx.exports (enable_ctx_exports) — loopback stubs for our capability classes.
  const exports = (ctx as unknown as { exports: Record<string, (o: { props: unknown }) => unknown> }).exports;
  const modules = { "probe.js": PROBE_SRC };
  const base = { area: "acceptance" as const, uid: TEST_UID, modules, mainModule: "probe.js" };
  const codeId = (n: string) => `acceptance:platform:${n}-v1`;

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
    await setStatus(env, saved.code_id, "pending_review", admin.uid);
    await setStatus(env, saved.code_id, "active", admin.uid);
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
