import { describe, expect, it } from "vitest";
import { commercialSessionAttachmentUpload } from "../src/routes/commercial_session_attachment";
import { signSessionToken } from "../src/routes/live";

// [APP-ONLY-TX-WORKER-RELAY-1] Route contract test for
// POST /api/commercial/session/:kind/:id/attachment -- no Clerk configured
// (CLERK_JWKS_URL unset), so every case here exercises the "guest" room-token
// lane plus the entitlement/rate-limit/mime/size gates.

class FakeKv {
  private store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
}

class FakeR2 {
  puts: { key: string; bytes: number; contentType?: string }[] = [];
  async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
    this.puts.push({ key, bytes: body.byteLength, contentType: opts?.httpMetadata?.contentType });
  }
}

class FakeD1 {
  constructor(private entitled: boolean) {}
  prepare(_sql: string) {
    const self = this;
    return {
      bind: (..._args: unknown[]) => ({
        first: async () => (self.entitled ? { 1: 1 } : null),
      }),
    };
  }
}

function makeEnv(opts: { entitled: boolean }) {
  return {
    JOIN_LINK_SECRET: "test-secret",
    BLOBS: new FakeR2(),
    BLOSSOM_BASE_URL: "https://blossom.avatok.ai",
    DB_META: new FakeD1(opts.entitled),
    TOKENS: new FakeKv(),
    // CLERK_JWKS_URL intentionally unset -- requireUser always fails, so
    // every request here must succeed (or not) purely on the room token.
  } as any;
}

const BOOKING_ID = "commercial-booking-abc123";

async function tokenFor(env: any, over: Partial<{ sid: string; uid: string; role: "host" | "viewer" | "attendee"; exp: number }> = {}) {
  return signSessionToken(env, {
    sid: over.sid ?? BOOKING_ID,
    uid: over.uid ?? "buyer-1",
    role: over.role ?? "attendee",
    order: null,
    name: "Buyer One",
    exp: over.exp ?? Date.now() + 3_600_000,
  });
}

function req(url: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}) {
  return new Request(url, { method: init.method ?? "POST", headers: init.headers, body: init.body });
}

const URL_BASE = `https://api.avatok.ai/api/commercial/session/consult/${BOOKING_ID}/attachment`;

describe("POST /api/commercial/session/:kind/:id/attachment", () => {
  it("uploads for a guest holding a valid room token + entitlement, returning {url,name,size,mime}", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/pdf", "x-file-name": "notes.pdf" },
        body: new Uint8Array([1, 2, 3, 4]).buffer,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe("notes.pdf");
    expect(body.size).toBe(4);
    expect(body.mime).toBe("application/pdf");
    expect(body.url).toMatch(/^https:\/\/blossom\.avatok\.ai\/sessions\//);
    expect((env.BLOBS as any).puts).toHaveLength(1);
    expect((env.BLOBS as any).puts[0].key).toContain(`sessions/${BOOKING_ID}/`);
  });

  it("rejects with 401 when there is no account and no valid room token", async () => {
    const env = makeEnv({ entitled: true });
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, { headers: { "content-type": "application/pdf" }, body: new Uint8Array([1]).buffer }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a room token for a different session id", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env, { sid: "commercial-booking-other" });
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/pdf" },
        body: new Uint8Array([1]).buffer,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an expired room token", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env, { exp: Date.now() - 1000 });
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/pdf" },
        body: new Uint8Array([1]).buffer,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a valid token with no matching commercial_entitlements row", async () => {
    const env = makeEnv({ entitled: false });
    const token = await tokenFor(env);
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/pdf" },
        body: new Uint8Array([1]).buffer,
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a disallowed mime type", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/x-msdownload" },
        body: new Uint8Array([1]).buffer,
      }),
      env,
    );
    expect(res.status).toBe(415);
  });

  it("rejects a body over the 25 MB cap even if content-length lies", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/pdf" },
        body: big.buffer,
      }),
      env,
    );
    expect(res.status).toBe(413);
  });

  it("rejects an empty body", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const res = await commercialSessionAttachmentUpload(
      req(URL_BASE, { headers: { "x-session-token": token, "content-type": "application/pdf" }, body: new Uint8Array([]).buffer }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rate-limits at 20 uploads per session per user", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    for (let i = 0; i < 20; i++) {
      const res = await commercialSessionAttachmentUpload(
        req(URL_BASE, {
          headers: { "x-session-token": token, "content-type": "application/pdf" },
          body: new Uint8Array([1]).buffer,
        }),
        env,
      );
      expect(res.status).toBe(200);
    }
    const blocked = await commercialSessionAttachmentUpload(
      req(URL_BASE, {
        headers: { "x-session-token": token, "content-type": "application/pdf" },
        body: new Uint8Array([1]).buffer,
      }),
      env,
    );
    expect(blocked.status).toBe(429);
  });

  it("accepts a multipart/form-data body with a 'file' part (the app client's shape)", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const form = new FormData();
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
    form.append("file", file);
    const res = await commercialSessionAttachmentUpload(
      new Request(URL_BASE, { method: "POST", headers: { "x-session-token": token }, body: form }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mime).toBe("image/png");
    expect(body.size).toBe(3);
    expect(body.name).toBe("photo.png");
    expect((env.BLOBS as any).puts).toHaveLength(1);
  });

  it("rejects multipart/form-data with no 'file' part", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const form = new FormData();
    form.append("caption", "hello");
    const res = await commercialSessionAttachmentUpload(
      new Request(URL_BASE, { method: "POST", headers: { "x-session-token": token }, body: form }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a multipart file part with a disallowed mime type", async () => {
    const env = makeEnv({ entitled: true });
    const token = await tokenFor(env);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "app.exe", { type: "application/x-msdownload" }));
    const res = await commercialSessionAttachmentUpload(
      new Request(URL_BASE, { method: "POST", headers: { "x-session-token": token }, body: form }),
      env,
    );
    expect(res.status).toBe(415);
  });

  it("404s on a malformed path", async () => {
    const env = makeEnv({ entitled: true });
    const res = await commercialSessionAttachmentUpload(
      req("https://api.avatok.ai/api/commercial/session/bogus/xyz/attachment", {
        headers: { "content-type": "application/pdf" },
        body: new Uint8Array([1]).buffer,
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});
