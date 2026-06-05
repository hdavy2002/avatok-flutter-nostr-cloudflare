// AWS Signature Version 4 signer — pure Web Crypto (no AWS SDK; SDK does not run
// on Workers). Used by AvaID (Phase 1) to call Rekognition Face Liveness over
// HTTPS from inside the Worker. Implements the documented SigV4 algorithm:
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
//
// PROBE (Phase 0.3): the signing-key derivation is verified against AWS's
// published test vector in scripts/sigv4_probe.mjs.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

/** Derive the SigV4 signing key: HMAC chain over date → region → service → "aws4_request". */
export async function signingKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(enc.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignParams {
  method: string;
  url: string;            // full https URL
  region: string;
  service: string;        // e.g. "rekognition"
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;  // for temporary credentials
  body?: string;          // request body (default "")
  headers?: Record<string, string>; // extra headers to sign (e.g. X-Amz-Target)
  now?: Date;             // injectable for tests
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Produce a fully signed request (Authorization header + x-amz-date +
 * x-amz-content-sha256). Caller passes the result straight to fetch().
 */
export async function signRequest(p: SignParams): Promise<SignedRequest> {
  const u = new URL(p.url);
  const body = p.body ?? "";
  const now = p.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  // Build the set of headers to sign. host + x-amz-date are mandatory.
  const hdrs: Record<string, string> = {
    host: u.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (p.sessionToken) hdrs["x-amz-security-token"] = p.sessionToken;
  for (const [k, v] of Object.entries(p.headers ?? {})) hdrs[k.toLowerCase()] = v;

  const sortedNames = Object.keys(hdrs).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${hdrs[n].trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    p.method.toUpperCase(),
    u.pathname || "/",
    u.searchParams.toString(), // query string (already URL-encoded by URLSearchParams)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kSigning = await signingKey(p.secretAccessKey, dateStamp, p.region, p.service);
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    `${algorithm} Credential=${p.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = {
    Authorization: authorization,
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
  };
  if (p.sessionToken) outHeaders["X-Amz-Security-Token"] = p.sessionToken;
  for (const [k, v] of Object.entries(p.headers ?? {})) outHeaders[k] = v;

  return { url: p.url, method: p.method.toUpperCase(), headers: outHeaders, body };
}

export interface PresignParams {
  url: string;            // full https URL to the object
  region: string;         // R2: "auto"
  service: string;        // R2: "s3"
  accessKeyId: string;
  secretAccessKey: string;
  expiresSec?: number;    // default 300
  now?: Date;
}

/**
 * SigV4 query-string presigned GET URL (e.g. R2 S3 API). The returned URL is
 * directly fetchable by the client for `expiresSec` seconds — no Authorization
 * header needed. Used by AvaOLX to hand out time-limited digital-download links.
 */
export async function presignGetUrl(p: PresignParams): Promise<string> {
  const u = new URL(p.url);
  const now = p.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const expires = String(p.expiresSec ?? 300);
  const credentialScope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const signedHeaders = "host";

  // Query params must be sorted; values URL-encoded.
  const q = new URLSearchParams();
  q.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  q.set("X-Amz-Credential", `${p.accessKeyId}/${credentialScope}`);
  q.set("X-Amz-Date", amzDate);
  q.set("X-Amz-Expires", expires);
  q.set("X-Amz-SignedHeaders", signedHeaders);
  // URLSearchParams sorts deterministically only if we build the canonical string ourselves.
  const canonicalQuery = [...q.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    u.pathname,
    canonicalQuery,
    `host:${u.host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
  const kSigning = await signingKey(p.secretAccessKey, dateStamp, p.region, p.service);
  const signature = toHex(await hmac(kSigning, stringToSign));
  return `${u.origin}${u.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
