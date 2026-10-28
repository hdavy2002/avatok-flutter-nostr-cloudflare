// @ts-nocheck -- node:sqlite is available in the Worker test runtime.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }),
  isFail: (value: any) => !!value?.error,
}));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));

import { hfRegistrationRoute, normalizeHfUsername } from "./hf_registration";
import { HF_REGISTRATION_POLICIES } from "../lib/hf_registration_policies";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
let db: any;
let env: any;
let kv: Map<string, string>;

function setup() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, updated_at INTEGER);
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, email_verified INTEGER);
    CREATE TABLE hf_phone_signup (uid TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE hf_user_registration (
      uid TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      terms_accepted_at INTEGER NOT NULL, privacy_accepted_at INTEGER NOT NULL,
      disclaimer_accepted_at INTEGER NOT NULL, community_accepted_at INTEGER NOT NULL,
      engagement_accepted_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO users(uid) VALUES ('u1'), ('u2');
    INSERT INTO contact_verification VALUES ('u1',1,1),('u2',1,1);
    INSERT INTO hf_phone_signup VALUES ('u1','done');
  `);
  db.exec(readFileSync(new URL('../../migrations/2026-10-12-hf-registration-progress.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../migrations/2026-10-23-hf-policy-reacceptances.sql', import.meta.url), 'utf8'));
  kv = new Map();
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => {
      const result = db.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  env = {
    DB_META: {
      prepare: (sql: string) => statement(sql),
      batch: async (items: any[]) => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const item of items) results.push(await item.run());
          db.exec('COMMIT');
          return results;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    },
    TOKENS: { get: async (key: string) => kv.get(key) ?? null },
  };
}

const policies = ["terms", "privacy", "disclaimer", "community", "engagement"];
const acceptedPolicyVersions = Object.fromEntries(Object.entries(HF_REGISTRATION_POLICIES).map(([key, value]) => [key, value.version]));
const registration = { firstName: 'Maya', lastName: 'Sharma', username: 'maya', acceptedPolicies: policies, acceptedPolicyVersions };
const call = (method = 'GET', body?: unknown, uid = 'u1') => hfRegistrationRoute(request('/api/hf/me/registration', method, body, uid), env, '/api/hf/me/registration');
const request = (path: string, method = "GET", body?: unknown, uid = "u1") => new Request(`https://x${path}`, {
  method,
  headers: { "content-type": "application/json", "x-test-uid": uid },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(setup);

describe("HF immutable registration username", () => {
  it("normalizes an allowed username", () => {
    expect(normalizeHfUsername("  Maya.Connect_27 ")).toBe("maya.connect_27");
  });

  it.each(["ma", "27maya", "maya..connect", "maya-connect", "maya connect", "a".repeat(31)])(
    "rejects %s",
    (value) => expect(normalizeHfUsername(value)).toBeNull(),
  );

  it("checks availability and saves every accepted policy", async () => {
    const available = await hfRegistrationRoute(request("/api/hf/me/username?value=Maya"), env, "/api/hf/me/username");
    expect(await available!.json()).toEqual({ available: true, username: "maya" });
    const response = await hfRegistrationRoute(request("/api/hf/me/registration", "POST", {
      ...registration, username: "Maya",
    }), env, "/api/hf/me/registration");
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, username: "maya", registrationComplete: true });
    expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBe("Maya Sharma");
    expect(db.prepare("SELECT terms_accepted_at FROM hf_user_registration WHERE uid='u1'").get().terms_accepted_at).toBeGreaterThan(0);
    const receipts = db.prepare("SELECT policy,document_version,accepted_at FROM hf_registration_policy_acceptances WHERE uid='u1'").all();
    expect(receipts).toHaveLength(5);
    for (const receipt of receipts) {
      expect(receipt.document_version).toBe(acceptedPolicyVersions[receipt.policy]);
      expect(receipt.accepted_at).toBeGreaterThan(0);
    }
  });

  it("requires all five policies and never writes a partial registration", async () => {
    const response = await hfRegistrationRoute(request("/api/hf/me/registration", "POST", {
      firstName: "Maya", lastName: "Sharma", username: "maya", acceptedPolicies: policies.slice(0, 4),
    }), env, "/api/hf/me/registration");
    expect(response!.status).toBe(400);
    expect((await response!.json()).missing).toEqual(["engagement"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_user_registration").get().n).toBe(0);
  });

  it("keeps a username immutable and unavailable to another account", async () => {
    const body = registration;
    expect((await hfRegistrationRoute(request("/api/hf/me/registration", "POST", body), env, "/api/hf/me/registration"))!.status).toBe(200);
    const changed = await hfRegistrationRoute(request("/api/hf/me/registration", "POST", { ...body, username: "maya2" }), env, "/api/hf/me/registration");
    expect(changed!.status).toBe(409);
    expect((await changed!.json()).error).toBe("username_locked");
    const other = await hfRegistrationRoute(request("/api/hf/me/username?value=maya", "GET", undefined, "u2"), env, "/api/hf/me/username");
    expect(await other!.json()).toEqual({ available: false, username: "maya" });
  });

  it.each([[0, 0, ['whatsapp', 'email']], [0, 1, ['whatsapp']], [1, 0, ['email']]])(
    'requires both authoritative contact proofs (%s, %s)', async (phone, email, missing) => {
      db.prepare("UPDATE contact_verification SET phone_verified=?,email_verified=? WHERE uid='u1'").run(phone, email);
      const response = await call('POST', { ...registration, whatsappVerified: true, emailVerified: true });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'contact_verification_required', missing });
      expect(db.prepare('SELECT COUNT(*) AS n FROM hf_user_registration').get().n).toBe(0);
      expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM hf_registration_policy_acceptances').get().n).toBe(0);
    });

  it('does not borrow another account proof when the caller has no proof row', async () => {
    db.prepare("DELETE FROM contact_verification WHERE uid='u1'").run();
    expect((await call('POST', { ...registration, uid: 'u2' })).status).toBe(403);
  });

  it('rechecks both proofs in the registration insert if verification changes', async () => {
    const batch = env.DB_META.batch;
    env.DB_META.batch = async (items) => {
      db.prepare("UPDATE contact_verification SET email_verified=0 WHERE uid='u1'").run();
      return batch(items);
    };
    expect((await call('POST', registration)).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hf_user_registration').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hf_registration_policy_acceptances').get().n).toBe(0);
    expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBeNull();
  });

  it('rolls back the registration and public name if consent receipts cannot be stored', async () => {
    db.exec('DROP TABLE hf_registration_policy_acceptances');
    expect((await call('POST', registration)).status).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hf_user_registration').get().n).toBe(0);
    expect(db.prepare("SELECT display_name FROM users WHERE uid='u1'").get().display_name).toBeNull();
  });

  it.each(['admin', 'SUPPORT', 'a.d.m.i.n', 'support_team', 'official123'])('reserves %s in both availability and registration', async (username) => {
    const available = await hfRegistrationRoute(request(`/api/hf/me/username?value=${username}`), env, '/api/hf/me/username');
    expect(await available.json()).toMatchObject({ available: false, reason: 'reserved' });
    expect(await (await call('POST', { ...registration, username })).json()).toMatchObject({ error: 'username_reserved' });
  });

  it('rejects missing or stale document versions without recording acceptance', async () => {
    for (const versions of [undefined, { ...acceptedPolicyVersions, terms: 'old' }]) {
      expect((await call('POST', { ...registration, acceptedPolicyVersions: versions })).status).toBe(409);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM hf_user_registration').get().n).toBe(0);
  });

  it('pins versions to the linked policy sources', () => {
    for (const policy of Object.values(HF_REGISTRATION_POLICIES)) {
      const source = readFileSync(new URL(`../../../web/src/pages${policy.path}.astro`, import.meta.url));
      expect(policy.version).toBe(`sha256:${createHash('sha256').update(source).digest('hex')}`);
    }
  });

  it('asks a registered person to accept changed policies once, and keeps the first receipt', async () => {
    const policyCall = (method = 'GET', body?: unknown, uid = 'u1') => hfRegistrationRoute(request('/api/hf/me/policy-update', method, body, uid), env, '/api/hf/me/policy-update');
    expect(await (await policyCall()).json()).toMatchObject({ required: false, pending: [] }); // not registered yet
    await call('POST', registration);
    expect(await (await policyCall()).json()).toMatchObject({ required: false });
    const old = 'sha256:' + '0'.repeat(64);
    db.prepare("UPDATE hf_registration_policy_acceptances SET document_version=?1 WHERE policy IN ('terms','privacy')").run(old);
    const status = await (await policyCall()).json();
    expect(status.required).toBe(true);
    expect(status.pending.map((p: any) => p.policy).sort()).toEqual(['privacy', 'terms']);
    expect(status.note).toContain('recorded for safety'); // [HF-CALL-SAFETY-LEGAL] changes with the pinned policy text
    const refused = await policyCall('POST', { acceptedPolicyVersions: { terms: acceptedPolicyVersions.terms } });
    expect(refused.status).toBe(409);
    expect((await policyCall('POST', { acceptedPolicyVersions })).status).toBe(200);
    expect(await (await policyCall()).json()).toMatchObject({ required: false, pending: [] });
    expect(db.prepare("SELECT document_version FROM hf_registration_policy_acceptances WHERE policy='terms'").get().document_version).toBe(old);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hf_policy_reacceptances').get().n).toBe(2);
  });

  it('resumes every completed step from server state without saving OTP codes', async () => {
    db.prepare("UPDATE contact_verification SET email_verified=0 WHERE uid='u1'").run();
    expect(await (await call()).json()).toMatchObject({ step: 2, registrationRequired: true });
    kv.set('otp:email:u1', JSON.stringify({ email: 'maya@example.test', hash: 'secret-hash', exp: Date.now() + 60_000, attempts: 0 }));
    const challenge = await (await call()).json();
    expect(challenge.step).toBe(3);
    expect(challenge.emailChallenge.email).toBe('maya@example.test');
    expect(JSON.stringify(challenge)).not.toContain('secret-hash');
    db.prepare("UPDATE contact_verification SET email_verified=1 WHERE uid='u1'").run();
    expect(await (await call()).json()).toMatchObject({ step: 4 });
    await call('PATCH', { step: 'name', firstName: 'Maya', lastName: 'Sharma', uid: 'u2', code: '123456' });
    expect(await (await call()).json()).toMatchObject({ step: 5, firstName: 'Maya', lastName: 'Sharma' });
    await call('PATCH', { step: 'username', username: 'maya' });
    expect(await (await call()).json()).toMatchObject({ step: 6, username: 'maya' });
    await call('PATCH', { step: 'kyc', kycNow: false });
    await call('PATCH', { step: 'policies', acceptedPolicyVersions: { terms: acceptedPolicyVersions.terms } });
    expect(await (await call()).json()).toMatchObject({ step: 7, kycNow: false, acceptedPolicyVersions: { terms: acceptedPolicyVersions.terms } });
    expect(await (await call('GET', undefined, 'u2')).json()).toMatchObject({ step: 4, firstName: null, registrationRequired: false });
    expect(JSON.stringify(db.prepare('SELECT * FROM hf_registration_progress').all())).not.toContain('123456');
    await call('POST', registration);
    expect(await (await call()).json()).toMatchObject({ step: 8, registrationRequired: false, registrationComplete: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM hf_registration_progress').get().n).toBe(0);
  });

  it('expired email challenges and stale saved consents must be renewed', async () => {
    db.prepare("UPDATE contact_verification SET email_verified=0 WHERE uid='u1'").run();
    kv.set('otp:email:u1', JSON.stringify({ email: 'maya@example.test', hash: 'old', exp: Date.now() - 1, attempts: 0 }));
    expect(await (await call()).json()).toMatchObject({ step: 2, emailChallenge: null });
    db.prepare("INSERT INTO hf_registration_progress (uid,accepted_policies_json,updated_at) VALUES ('u1',?,1)").run(JSON.stringify({ terms: 'old' }));
    expect((await (await call()).json()).acceptedPolicyVersions).toEqual({});
  });
});
