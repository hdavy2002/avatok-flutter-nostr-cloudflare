// @ts-nocheck -- request/fetch mocks exercise the route without live services.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../util';

vi.mock('../authz', () => ({
  requireUser: async () => ({ uid: 'account_1', clerkUserId: 'user_current' }),
  isFail: () => false,
}));
vi.mock('../hooks', () => ({ track: vi.fn(), trackUser: vi.fn(), metric: vi.fn(), brainFact: vi.fn() }));
import { idEmailVerify } from './id';

let kv: Map<string, string>;
let writes: { sql: string; values: unknown[] }[];
let env: any;
let fetchMock: ReturnType<typeof vi.fn>;
const email = 'person@example.test';
const key = 'otp:email:account_1';
const user = (addresses = [], id = 'user_current') => ({ id, email_addresses: addresses, primary_email_address_id: null });
const address = (status = 'verified') => ({ id: 'email_1', email_address: email, verification: { status } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const verify = (code = '123456') => idEmailVerify(new Request('https://x/api/id/email/verify', {
  method: 'POST', body: JSON.stringify({ email, code, uid: 'someone_else' }),
}), env);

beforeEach(async () => {
  kv = new Map([[key, JSON.stringify({ hash: await sha256Hex(`account_1:${email}:123456`), email, exp: Date.now() + 60_000, attempts: 0 })]]);
  writes = [];
  env = {
    CLERK_SECRET_KEY: 'test-secret',
    TOKENS: { get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    DB_META: { prepare: (sql) => ({ bind: (...values) => ({ run: async () => { writes.push({ sql, values }); return {}; } }) }) },
  };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('email verification links the authenticated Clerk identity before local proof', () => {
  it('creates a verified email on the actual Clerk subject, then checks ownership', async () => {
    fetchMock.mockResolvedValueOnce(response(user()))
      .mockResolvedValueOnce(response(address()))
      .mockResolvedValueOnce(response(user([address()])));
    expect(await (await verify()).json()).toEqual({ ok: true, verified: true });
    expect(fetchMock.mock.calls[0][0]).toContain('/users/user_current');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      user_id: 'user_current', email_address: email, verified: true, primary: true,
    });
    expect(writes.some((w) => w.sql.includes('INSERT INTO contact_verification') && w.values[0] === 'account_1')).toBe(true);
    expect(kv.has(key)).toBe(false);
  });

  it('verifies an existing email on the same user without creating a second user', async () => {
    fetchMock.mockResolvedValueOnce(response(user([address('unverified')])))
      .mockResolvedValueOnce(response(address()))
      .mockResolvedValueOnce(response(user([address()])));
    expect((await verify()).status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toContain('/email_addresses/email_1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');
  });

  it('accepts a previously linked verified email without a write to Clerk', async () => {
    fetchMock.mockResolvedValueOnce(response(user([address()])));
    expect((await verify()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a collision without moving the email, consuming the code, or persisting proof', async () => {
    fetchMock.mockResolvedValueOnce(response(user()))
      .mockResolvedValueOnce(response({ errors: [{ code: 'form_identifier_exists' }] }, 422))
      .mockResolvedValueOnce(response(user()));
    const result = await verify();
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: 'email_taken', field: 'email' });
    expect(writes).toEqual([]);
    expect(kv.has(key)).toBe(true);
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('someone_else'))).toBe(true);
  });

  it('does not claim success for a 200 response without same-user verified readback', async () => {
    fetchMock.mockResolvedValueOnce(response(user()))
      .mockResolvedValueOnce(response(address()))
      .mockResolvedValueOnce(response(user([address()], 'user_other')));
    expect((await verify()).status).toBe(503);
    expect(writes).toEqual([]);
    expect(kv.has(key)).toBe(true);
  });

  it('retries safely after a provider outage', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect((await verify()).status).toBe(503);
    expect(writes).toEqual([]);
    expect(kv.has(key)).toBe(true);
    fetchMock.mockResolvedValueOnce(response(user([address()])));
    expect((await verify()).status).toBe(200);
  });

  it('fails closed without the Clerk secret', async () => {
    delete env.CLERK_SECRET_KEY;
    expect((await verify()).status).toBe(503);
    expect(writes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never links an email for a wrong OTP', async () => {
    expect((await verify('000000')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(JSON.parse(kv.get(key)).attempts).toBe(1);
  });
});
