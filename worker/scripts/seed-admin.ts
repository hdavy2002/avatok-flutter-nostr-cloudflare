/**
 * seed-admin.ts — idempotent admin seed helper (PHASE 6, §2).
 *
 * SECURITY: this script NEVER writes a password anywhere. The admin password is
 * set directly in Clerk (dashboard or Backend API) by the operator. This helper
 * only (a) looks up the Clerk user id by email, (b) prints the uid for the
 * operator to append to ADMIN_UIDS in wrangler.toml [vars] (prod + staging),
 * and (c) optionally writes an `admin_audit` row recording the grant via the
 * deployed Worker's existing admin endpoints.
 *
 * Run manually (Phase Z), with secrets supplied in the ENVIRONMENT — never
 * inlined and never committed:
 *
 *   CLERK_SECRET_KEY=sk_live_... \
 *   ADMIN_EMAIL=hdavy2002@gmail.com \
 *   node --experimental-strip-types worker/scripts/seed-admin.ts
 *
 * (or compile with tsc / run with tsx). Node 18+ has global fetch.
 *
 * Exit codes: 0 found+printed, 2 not found, 3 missing config.
 */

interface ClerkUser {
  id: string;
  email_addresses?: Array<{ email_address: string; id: string }>;
  primary_email_address_id?: string;
}

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "hdavy2002@gmail.com").trim().toLowerCase();
const CLERK_API = process.env.CLERK_API_BASE ?? "https://api.clerk.com/v1";

async function findUserByEmail(email: string): Promise<ClerkUser | null> {
  // Clerk Backend API: GET /v1/users?email_address=<addr>
  const url = `${CLERK_API}/users?email_address=${encodeURIComponent(email)}&limit=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Clerk lookup failed: ${res.status} ${await res.text()}`);
  }
  const users = (await res.json()) as ClerkUser[];
  // Exact (case-insensitive) primary-or-any email match.
  for (const u of users) {
    const emails = (u.email_addresses ?? []).map((e) => e.email_address.toLowerCase());
    if (emails.includes(email)) return u;
  }
  return null;
}

async function main(): Promise<void> {
  if (!CLERK_SECRET_KEY) {
    console.error("[seed-admin] CLERK_SECRET_KEY is required in the environment (not committed).");
    process.exit(3);
  }
  console.error(`[seed-admin] Looking up Clerk user for ${ADMIN_EMAIL} …`);
  const user = await findUserByEmail(ADMIN_EMAIL);
  if (!user) {
    console.error(
      `[seed-admin] No Clerk user found for ${ADMIN_EMAIL}.\n` +
        `  → Create the user in the Clerk dashboard (set the owner-supplied password THERE),\n` +
        `    then re-run this script. The password is never stored in the repo.`,
    );
    process.exit(2);
  }

  // The only output the operator needs: the uid to paste into ADMIN_UIDS.
  console.log(user.id);
  console.error("\n[seed-admin] NEXT STEPS (Phase Z, manual):");
  console.error(`  1. Append this uid to ADMIN_UIDS in worker/wrangler.toml [vars] (prod AND staging):`);
  console.error(`       ${user.id}`);
  console.error(`  2. Redeploy the Worker (prod + staging).`);
  console.error(`  3. (optional) Record the grant in admin_audit, e.g. via D1:`);
  console.error(
    `       wrangler d1 execute avatok-wallet --remote --command \\\n` +
      `         "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) ` +
      `VALUES ('${cryptoId()}','seed-admin','admin_granted','${user.id}','{\\"email\\":\\"${ADMIN_EMAIL}\\"}',${Date.now()})"`,
  );
  console.error("\n[seed-admin] No password was read, written, or transmitted by this script.");
}

function cryptoId(): string {
  // Best-effort UUID without importing node:crypto types.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `seed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

main().catch((e) => {
  console.error("[seed-admin] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
