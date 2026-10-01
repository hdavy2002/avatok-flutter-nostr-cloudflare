import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { astroCall } from './client';
import { stableStringify, nextIstMidnight, istDate } from './cache';
import { geoLookup } from './geo';
import { toGeminiFunctionDeclarations, mcpListTools, mcpCallTool, _resetMcpCache } from './mcp';

// Minimal fake D1: one table keyed by the first bind param.
function fakeEnv(withKey = true) {
  const rows = new Map<string, any>();
  const events: any[] = [];
  const env: any = {
    ASTROLOGYAPI_KEY: withKey ? 'k-test' : undefined,
    Q_ANALYTICS: { send: async (e: any) => { events.push(e); } },
    DB_META: {
      prepare(sql: string) {
        return {
          bind(...b: any[]) {
            return {
              first: async () => rows.get(b[0]) ?? null,
              run: async () => { rows.set(b[0], { json: b[2], expires_at: b[4] }); return {}; },
            };
          },
        };
      },
    },
  };
  return { env, rows, events };
}

const BIRTH = { year: 1990, month: 5, day: 12, hour: 6, minute: 30, latitude: 30.3, longitude: 78, timezone: 5.5, ayanamsha: 23.72, sunrise: '6:19:19', sunset: '18:57:11' };
const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); _resetMcpCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('astroCall', () => {
  it('returns astro_not_configured without a key and never calls the network', async () => {
    const { env } = fakeEnv(false);
    expect(await astroCall(env, 'birth_details', {})).toEqual({ ok: false, error: 'astro_not_configured', status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the key header, caches forever, and serves the second call from cache', async () => {
    const { env, events } = fakeEnv();
    fetchMock.mockResolvedValue(jsonRes(BIRTH));
    const body = { day: 12, month: 5, year: 1990, hour: 6, min: 30, lat: 30.3, lon: 78, tzone: 5.5 };
    const a = await astroCall(env, 'birth_details', body, { ttl: 'forever', uid: 'u1' });
    const b = await astroCall(env, 'birth_details', { ...body }, { ttl: 'forever', uid: 'u1' });
    expect(a).toEqual({ ok: true, data: BIRTH });
    expect(b).toEqual({ ok: true, data: BIRTH });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://json.astrologyapi.com/v1/birth_details');
    expect(init.headers['x-astrologyapi-key']).toBe('k-test');
    expect(init.headers['Accept-Language']).toBeUndefined();
    expect(events.map((e) => [e.event, e.props.cached, e.props.ok])).toEqual([['astro_api_call', false, true], ['astro_api_call', true, true]]);
  });

  it('maps {status:false,error_msg} and HTTP errors to typed errors, and does not cache them', async () => {
    const { env, rows } = fakeEnv();
    fetchMock.mockResolvedValueOnce(jsonRes({ status: false, error_msg: 'Invalid input' }));
    expect(await astroCall(env, 'planets', {}, { ttl: 'forever' })).toEqual({ ok: false, error: 'Invalid input', status: 200 });
    fetchMock.mockResolvedValueOnce(jsonRes({ msg: 'quota' }, 429));
    expect(await astroCall(env, 'planets', {}, { ttl: 'forever' })).toMatchObject({ ok: false, error: 'quota', status: 429 });
    expect(rows.size).toBe(0);
  });

  it('uses the vision host and Accept-Language only when asked', async () => {
    const { env } = fakeEnv();
    fetchMock.mockResolvedValue(jsonRes({ ok: 1 }));
    await astroCall(env, 'palmistry/x', {}, { host: 'vision', lang: 'hi' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://vision.astrologyapi.com/palmistry/x');
    expect(init.headers['Accept-Language']).toBe('hi');
  });

  it('reports a network failure as astro_network', async () => {
    const { env } = fakeEnv();
    fetchMock.mockRejectedValue(new Error('boom'));
    expect(await astroCall(env, 'planets', {})).toEqual({ ok: false, error: 'astro_network', status: 0 });
  });
});

describe('cache helpers', () => {
  it('stableStringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('nextIstMidnight lands on 18:30 UTC and after now', () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    const m = nextIstMidnight(now);
    expect(m).toBe(Date.UTC(2026, 9, 1, 18, 30, 0));
    expect(m).toBeGreaterThan(now);
    expect(istDate(Date.UTC(2026, 9, 1, 19, 0, 0))).toBe('2026-10-02');
  });
});

describe('geoLookup', () => {
  it('normalises geo_details rows', async () => {
    const { env } = fakeEnv();
    fetchMock.mockResolvedValue(jsonRes([{ place_name: 'Dehradun, Uttarakhand', latitude: 30.32, longitude: 78.03, timezone_id: 'Asia/Kolkata', country_code: 'IN' }]));
    const r = await geoLookup(env, 'Dehradun');
    expect(r).toEqual({ ok: true, data: [{ place_name: 'Dehradun, Uttarakhand', lat: 30.32, lon: 78.03, timezone_id: 'Asia/Kolkata', country_code: 'IN' }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ place: 'Dehradun', maxRows: 5 });
  });
});

describe('mcp', () => {
  const rpcRes = (result: unknown) => jsonRes({ jsonrpc: '2.0', id: 1, result });

  it('lists tools (cached) and converts to Gemini declarations', async () => {
    const { env } = fakeEnv();
    const tool = { name: 'birth_details', description: 'd', inputSchema: { $schema: 'x', type: 'object', additionalProperties: false, properties: { day: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['day'] } };
    fetchMock.mockResolvedValueOnce(rpcRes({})).mockResolvedValueOnce(rpcRes({ tools: [tool, { name: 'other' }] }));
    const tools = await mcpListTools(env);
    expect(Array.isArray(tools)).toBe(true);
    await mcpListTools(env);
    expect(fetchMock).toHaveBeenCalledTimes(2); // second list came from the isolate cache
    const decl = toGeminiFunctionDeclarations(tools as any, ['birth_details']);
    expect(decl).toEqual([{ name: 'birth_details', description: 'd', parameters: { type: 'OBJECT', properties: { day: { type: 'INTEGER' }, tags: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['day'] } }]);
  });

  it('parses tools/call text JSON and SSE bodies', async () => {
    const { env } = fakeEnv();
    fetchMock.mockResolvedValueOnce(rpcRes({}))
      .mockResolvedValueOnce(new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(BIRTH) }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await mcpCallTool(env, 'birth_details', { day: 12 })).toEqual(BIRTH);
  });

  it('returns {error} when unconfigured', async () => {
    const { env } = fakeEnv(false);
    expect(await mcpCallTool(env, 'x', {})).toEqual({ error: 'astro_not_configured' });
  });
});
