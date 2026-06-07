# Two Products: Parent & Enterprise — Possibilities Report

_Status: research / design proposal · 2026-06-07_
_Author: codebase research pass over `avaTOK-2-Flutter`_

## 1. What you asked for

At the login/registration screen, branch into **two products**:

- **Join as a Parent** → a Parent dashboard. Parents create accounts for their
  children, give them a curated set of apps, and get a bird's-eye view of what the
  kids are doing (who they talk to, what they browse, their social life).
- **Join as an Enterprise** → an Enterprise registration. The registering manager
  becomes a **super-admin** of a company workspace. They get "manage apps":
  onboard employees into a company social/user group, grant or block access to
  specific apps. Crucially, the employee's company social + corporate accounts are
  **owned by the org**, not the person. When the employee leaves, they don't walk
  out with the company's social graph and software — it stays with the manager. The
  manager can block that user, who must then create their own _personal_ AvaTalk
  account to keep using anything.

Phone OTP and email OTP come later as part of registration (Clerk already supports
both on the shared `avatok.ai` tenant).

This report explains how the current codebase is built, why it's unusually
well-suited to this, the realistic product/architecture options, a recommended
model, and a concrete phased build plan.

---

## 2. The single most important finding

**AvaTOK already separates "the account" from "the identity," and that separation
is exactly the primitive both products need.**

- **Account = Clerk.** Email/password today, phone+email OTP next. One shared
  `avatok.ai` Clerk tenant (`pk_live_...avatok.ai`). The Worker verifies a
  short-lived Clerk session JWT against Clerk's JWKS (`worker/src/auth.ts →
  verifyClerk`).
- **Identity = a Nostr keypair (npub/nsec).** The private key signs every write
  (NIP-98, `verifyNip98`). This npub _is_ the user — their profile, social graph,
  DMs, wallet, and AI memory all hang off it. Encrypted key backup is optional
  (`clerk_nostr_link.encrypted_nsec_backup`).
- The two are joined in one table — `clerk_nostr_link (clerk_user_id ↔ npub,
  tier)` in `worker/migrations/meta.sql`.

Why this matters: a "company-owned account" or a "parent-provisioned child
account" is just **an npub whose keys were generated and are custodied by the
org/parent rather than by the end user.** Because identity lives in a keypair the
provisioner controls, "the data stays with the manager when the employee leaves"
isn't a feature you have to bolt on — it's the natural consequence of who holds the
key. That is a genuinely strong position; most platforms have to build elaborate
account-transfer machinery to get what you get almost for free here.

Everything below builds on that one idea: **custodial (org/parent-held) identities
vs. self-custodial (personal) identities, grouped under a tenant.**

---

## 3. How the system works today (the parts that matter)

**Auth & gating** (`worker/src/auth.ts`)
- Every mutation requires NIP-98 (proves the npub) **and** (when
  `CLERK_JWKS_URL` is set) a Clerk JWT (proves the account). Reads are open.
- There is already a per-account **`tier`** (`basic | verified | suspended`) and a
  separate **`account_status`** (`active | temp_blocked | perm_banned |
  under_review`) with a strike system. Blocking a user is already a solved problem.
- `requireVerifiedKV()` is the canonical entitlement check pattern — KV-cached, D1
  fallback. **New entitlement checks (app access, role) should copy this exact
  pattern.**

**The app catalog** (`app/lib/core/apps.dart`)
- 15 "AvaVerse" apps are declared **client-side** as `AppDef`s (AvaTOK, AvaLive,
  AvaAI, AvaTweet, AvaBook, AvaGram, AvaLinked, AvaTube, AvaAds, AvaTind,
  AvaMatri, AvaNote, AvaWeb, AvaAgent, AvaVoice).
- Which apps a user sees is currently stored **only on the device**
  (`OnboardingStore`, secure storage, `enabled_apps`). **There is no server-side
  entitlement** — a user can enable anything. For Parent/Enterprise, app access
  must become **server-enforced**, because "the manager blocks an app" has to be
  authoritative, not a local toggle.

**Sidebar / shell** (`app/lib/shell/ava_shell.dart`, `ava_sidebar.dart`)
- The signed-in shell reads `enabledApps()` and renders the sidebar from it. This
  is the single place a "role-aware app list" needs to be injected.

**Group precedent already exists** (`worker/migrations/meta.sql`)
- `communities` + `community_members (role: owner|admin|member)` is a working
  membership-with-roles table. An Enterprise workspace is essentially a
  first-class, permissioned version of a community.

**Account deletion is a full cascade** — wipes media, chat, contacts, AI memory,
profile across every store. Relevant because Parent/Enterprise need _scoped_
deletion ("remove this child," "offboard this employee") that must be careful
**not** to nuke org-owned data.

**No multi-tenant / parent / enterprise scaffolding exists yet.** Greenfield. The
only references in `Specs/` are about reusing the Clerk _tenant_, not org tenancy.

---

## 4. The core design choice: how do accounts relate?

Everything hinges on one decision — **who holds the child's / employee's keys.**

### Option A — Custodial identities (RECOMMENDED)
The parent/org **provisions** the sub-account: the keypair is generated and its
`nsec` is custodied by the tenant (encrypted, escrowed to the parent/org owner).
The child/employee logs in, but the org/parent can rotate, suspend, or reclaim the
identity.

- ✅ "Data stays with the manager" is automatic — the org holds the key.
- ✅ Parent can fully oversee a young child who may not manage keys.
- ✅ Matches your exact requirement: leaver loses the company identity; manager
  keeps the social graph, content, and corporate apps tied to that npub.
- ⚠️ You become a key custodian → real responsibility (encryption at rest, access
  logs, legal/consent posture, especially for minors).
- ⚠️ "Employee privacy at work" needs an honest, documented policy.

### Option B — Linked self-custodial identities
Child/employee holds their own keys; the parent/org gets an **oversight grant**
(a signed delegation) over a personal account.

- ✅ Cleaner privacy story; no key escrow.
- ❌ Breaks the "everything stays with the manager" requirement — the leaver keeps
  their keys and their data. Doesn't match what you described.
- ❌ Weak for young children.

### Option C — Hybrid (the pragmatic real answer)
- **Enterprise → custodial (Option A).** Corporate/social accounts are org assets.
- **Parent → custodial for under-13, "managed self-custodial" for teens** — a
  young child's keys are parent-held; an older teen can hold their own keys with a
  parental oversight grant that can later be released into a fully independent
  personal account. This mirrors real family dynamics _and_ child-safety law,
  which treats a 9-year-old and a 16-year-old very differently.

**Recommendation: build the custodial primitive first (it's the harder, shared
core), ship Enterprise on it, then layer the teen "managed self-custodial" variant
for Parent.**

---

## 5. The unifying data model

Add **tenancy + roles** to the existing identity link rather than inventing a
parallel system. One new concept — a **tenant** (a family or a company) — plus a
**membership** with a role and a per-app **entitlement**.

### 5.1 New tables (DB_META)

```sql
-- A tenant = one family OR one company workspace.
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,           -- uuid
  type          TEXT NOT NULL,              -- 'family' | 'enterprise'
  name          TEXT NOT NULL,              -- "The Davy Family" / "Acme Corp"
  owner_npub    TEXT NOT NULL,              -- the parent / super-admin
  plan          TEXT,                       -- billing tier (enterprise seats etc.)
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_tenant_owner ON tenants(owner_npub);

-- Who belongs to a tenant, in what role, and whether the tenant holds their keys.
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id     TEXT NOT NULL,
  npub          TEXT NOT NULL,
  role          TEXT NOT NULL,              -- 'owner'|'admin'|'manager'|'member'|'child'
  custody       TEXT NOT NULL DEFAULT 'self', -- 'tenant' (org/parent-held) | 'self'
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- 'active'|'suspended'|'offboarded'
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, npub)
);
CREATE INDEX IF NOT EXISTS idx_member_npub ON tenant_members(npub);

-- Per-(member, app) access. The AUTHORITATIVE source for the app list.
-- Absence = use the tenant default for that role.
CREATE TABLE IF NOT EXISTS app_entitlements (
  tenant_id   TEXT NOT NULL,
  npub        TEXT NOT NULL,
  app_key     TEXT NOT NULL,                -- 'avatok','avatweet',... (matches apps.dart)
  state       TEXT NOT NULL,                -- 'allowed' | 'blocked'
  set_by      TEXT NOT NULL,                -- admin npub who set it
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, npub, app_key)
);
CREATE INDEX IF NOT EXISTS idx_entitle_member ON app_entitlements(npub);

-- Encrypted custody of provisioned keys (org/parent-held identities).
-- Sealed to the owner; server stores ciphertext only.
CREATE TABLE IF NOT EXISTS custodial_keys (
  npub               TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  encrypted_nsec     TEXT NOT NULL,         -- NIP-49 / envelope-encrypted
  escrow_owner_npub  TEXT NOT NULL,         -- parent / super-admin who can recover
  created_at         INTEGER NOT NULL
);
```

Extend `clerk_nostr_link` with one nullable column so existing rows are untouched:

```sql
ALTER TABLE clerk_nostr_link ADD COLUMN account_kind TEXT DEFAULT 'personal';
-- 'personal' | 'parent' | 'child' | 'enterprise_admin' | 'enterprise_member'
```

### 5.2 The entitlement resolver (server, mirrors `requireVerifiedKV`)
One function answers "which apps can this npub open?" — KV-cached, D1 source of
truth, invalidated whenever an admin/parent changes an entitlement:

```
appsFor(npub):
  if no tenant membership → personal: all apps (today's behaviour)
  else → role default set  ⊕  app_entitlements overrides (blocked wins)
  cache as apps:{npub} in KV (1h TTL); bust on any entitlement write
```

The Flutter shell stops trusting `OnboardingStore` for access and instead renders
the sidebar from a new `GET /api/me/apps`. `OnboardingStore` survives only as a
personal-preference "hide/show" layer _within_ what you're entitled to.

---

## 6. Product A — Parent

**Registration:** "Join as a Parent" creates a `tenants(type='family')` with the
parent as `owner`. Parent verifies via Clerk (email/phone OTP).

**Create a child account:** Parent taps "Add child," enters a name/age. Server
generates a keypair, stores it in `custodial_keys` escrowed to the parent,
inserts a `tenant_members(role='child', custody='tenant')` row, and applies an
age-appropriate **default app set** (e.g. AvaTOK + AvaNote on; AvaTind/AvaMatri/
AvaAds always off for minors — enforced, not just hidden). The child signs in with
their own simple credential under the family tenant.

**Parent dashboard (bird's-eye view) — realistic scope, by tier of intrusiveness:**

1. **Roster & controls (uncontroversial):** list of children, which apps each can
   use, per-app allow/block toggles, screen-time windows, "request to add an app"
   approvals. This is pure entitlement UI on the model above.
2. **Social graph visibility (moderate):** who the child follows / is followed by,
   pending contact requests, new connections — all already queryable from
   `follows`, `communities`, contact match. A parent approving new contacts for a
   young child is a clean, defensible feature.
3. **Activity overview (sensitive):** "what they're browsing / their social life."
   Be deliberate here. Defensible: app-usage summaries, posts the child made
   _publicly_, AvaBrain-style daily digests ("Aanya joined 2 communities, posted 3
   photos"). **Not** defensible technically or ethically: reading the child's
   **end-to-end-encrypted DMs** — the system is explicitly built so the server
   _cannot_ read them (NIP-44), and breaking that would betray the whole product's
   privacy promise. Recommended stance: **transparency dashboards over public/
   metadata activity + safety alerts (e.g. flagged content, contact from
   unknown adults), with age-banded settings and clear disclosure to the child.**
   This is both the safer legal posture (COPPA/GDPR-K and similar) and the more
   honest product.

**Graduation:** when a child comes of age, the parent can **release custody** —
the escrowed key converts to a self-custodial personal account, the
`tenant_members` row is removed, and they keep their own data. (Same mechanism the
enterprise leaver does _not_ get.)

---

## 7. Product B — Enterprise

**Registration:** "Join as an Enterprise" creates `tenants(type='enterprise')`,
registering manager becomes `owner`/super-admin. (Optionally gate behind a verified
company email domain via Clerk.)

**Super-admin "Manage Apps" console:**
- **Onboard employees:** invite by email/phone. Two modes:
  - _Org-owned (custodial):_ server provisions the npub, escrowed to the org. This
    is the corporate/social identity that **stays with the company.**
  - _BYO-personal (linked):_ employee links their existing personal AvaTalk for SSO
    convenience but the org grants no custody — used for contractors.
- **Social user group:** all org members auto-join an enterprise community
  (reuse `communities`/`community_members`) — the internal directory + group DMs.
- **Per-employee app grants:** allow/block any AvaVerse app per person or per team
  via `app_entitlements`. "Sales gets AvaLinked + AvaAds; interns don't get
  AvaAds." Block is authoritative and takes effect on next `GET /api/me/apps`
  (cache-busted instantly).
- **Roles:** `owner` (super-admin) → `admin`/`manager` (can manage a team) →
  `member`. Copy the `community_members` role pattern.

**Offboarding (your headline requirement):** When an employee leaves, the
super-admin hits "Offboard." For an **org-owned identity**:
- `tenant_members.status='offboarded'`, all `app_entitlements` flipped to
  `blocked`, the Clerk session revoked, the npub's `account_status='suspended'`.
- The **npub, its social graph, content, communities, and corporate app data
  remain owned by the tenant** (the org still holds the escrowed key). The manager
  can reassign that identity to a successor or freeze it.
- The person keeps **nothing** of the company's — to keep using AvaTalk they
  "Create your own personal AvaTalk account," which mints a fresh self-custodial
  npub with zero inheritance. Exactly the behaviour you described.

This is the payoff of the custodial model: offboarding is a status flip + key
retention, not a data-migration project.

---

## 8. Auth & registration changes (Clerk)

- **Product branch at sign-up.** Add an account-kind selector before the Clerk
  flow ("Personal / Parent / Enterprise"). Persist the choice as Clerk
  **`publicMetadata.account_kind`** + `tenant_id` so it's available in the session
  JWT and the Worker can read it without a DB hit.
- **Phone + email OTP (already planned).** Enable phone OTP and email-code as
  first factors on the `avatok.ai` tenant — the Flutter `ClerkClient` already
  speaks the FAPI verification flow; you mainly add the phone-OTP strategy and a UI
  step. No architectural change.
- **Worker reads role from the JWT.** Extend `AuthCtx` with `accountKind` and
  `tenantId` pulled from Clerk claims (fallback to `clerk_nostr_link.account_kind`).
  Add `requireTenantRole(ctx, tenantId, roles[])` next to `requireVerifiedKV`.
- **Custody UX.** For provisioned accounts, the child/employee gets a login but the
  `nsec` is sealed in `custodial_keys` to the owner — the device never needs the
  raw key for day-to-day use if signing is brokered, or receives a
  device-scoped subkey. (Decide: server-side signing broker vs. sealed-key
  download. Server-side broker is simpler to reclaim on offboarding.)

---

## 9. Flutter changes

- **New entry screen:** `Join as Parent` / `Join as Enterprise` / `Personal`
  alongside the existing `SignInScreen`.
- **Server-driven app list:** `ava_shell.dart` renders the sidebar from
  `GET /api/me/apps` instead of `OnboardingStore.enabledApps()`. Keep
  `OnboardingStore` only as a local "show/hide within my entitlements" preference.
- **Parent dashboard** feature module: child roster, per-child app toggles,
  social/contact approvals, activity digest (built on AvaBrain summaries).
- **Enterprise console** feature module: employee list, invite, team/role
  management, per-app grant matrix, offboard button.
- **`apps.dart` gains a `minAge` / `audience` field** so the entitlement defaults
  (e.g. "no dating apps for children") are declared in one place.

---

## 10. Risks & things to decide

- **Key custody is the crux.** Decide server-side signing broker vs. sealed-key
  escrow. The broker makes reclaim/offboarding trivial and keeps phones simple, at
  the cost of the server being able to sign for custodial accounts (acceptable for
  org/parent-owned identities; **never** for personal ones — keep that line bright).
- **Child safety & law.** Minors + monitoring invokes COPPA (US), GDPR-K (EU),
  India's DPDP Act, age-verification rules, and app-store policies for kids'
  products. The E2EE DMs are an asset here — lean into "we monitor public activity
  and safety signals, we cannot and do not read private messages." Get this
  reviewed before launch; this report is not legal advice.
- **Employee-privacy expectations.** Document what the org can and can't see.
  Over-reaching here is reputational risk.
- **Don't let scoped deletion hit the cascade.** Offboarding must NOT trigger the
  full account-erasure cascade — that wipes data the org wants to keep. Add a
  distinct "offboard" path separate from "delete account."
- **Entitlement cache correctness.** Any allow/block write must bust `apps:{npub}`
  in KV immediately, or a blocked app lingers for up to the TTL.

---

## 11. Recommended phasing

1. **Phase 0 — Tenancy core.** `tenants`, `tenant_members`, `app_entitlements`
   tables; `appsFor(npub)` resolver + `GET /api/me/apps`; `account_kind` on the
   identity link and Clerk metadata. Flutter shell reads the server app list.
   _Ship behind a flag; personal users see no change._
2. **Phase 1 — Enterprise.** Super-admin console: create workspace, invite +
   custodial provisioning, social group, per-app grant matrix, offboarding (status
   flip + key retention). This proves the custodial primitive end-to-end.
3. **Phase 2 — Parent.** Family tenant, child provisioning with age-banded app
   defaults, roster + per-child controls, social/contact approvals.
4. **Phase 3 — Oversight dashboard.** Parent activity digests via AvaBrain,
   safety alerts, screen-time windows. (Most sensitive — ship last, with the
   privacy posture nailed down.)
5. **Phase 4 — Graduation/release.** Convert a custodial child/teen identity into
   a self-custodial personal account; the enterprise-leaver "create your own
   account" path.

---

## 12. Bottom line

You don't need to re-architect anything. The account/identity split, the per-account
`tier`/`status` gating, the `requireVerifiedKV` entitlement pattern, the
community-membership-with-roles table, and the full E2EE story are all already in
place. The two products are mostly **one new primitive — tenant-held (custodial)
identities grouped under a tenant with server-enforced per-app entitlements** —
plus two dashboards on top. Enterprise and Parent are the same machine pointed at a
company vs. a family; build the custodial core once, ship Enterprise on it, then
add the parent oversight layer.
