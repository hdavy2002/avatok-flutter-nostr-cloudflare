// k6 load test — InboxDO messaging path (Scale proposal Phase 0).
//
// Drives the REAL client protocol per virtual user:
//   1. WSS connect to /api/inbox (one hibernatable socket per user's InboxDO)
//   2. {type:'hello', cursor:0}  → expect {type:'sync'}
//   3. POST /api/msg/send to a random peer in the pool every MSG_INTERVAL_S
//   4. measure live-delivery latency (send ts → 'msg' frame on the peer's socket)
//
// AUTH: every VU needs a Clerk JWT. Generate a pool of test-user tokens first
// (see README.md) and pass them via TOKENS_FILE (one JWT per line, uid:jwt).
//
// Run (example — 1k VUs ramping to 10k):
//   k6 run -e BASE=api.avatok.ai -e TOKENS_FILE=./tokens.txt \
//          -e VUS=1000 -e DURATION=10m -e MSG_INTERVAL_S=15 k6-inbox.js
//
// Pass/fail gates (audit budgets): p99 delivery < 1.5s, send errors < 1%.

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE = __ENV.BASE || 'api.avatok.ai';
const MSG_INTERVAL_S = Number(__ENV.MSG_INTERVAL_S || 15);

const deliveryMs = new Trend('msg_delivery_ms', true);
const syncMs = new Trend('first_sync_ms', true);
const sendFail = new Rate('send_fail');

const tokens = new SharedArray('tokens', () => {
  // each line: "<uid>:<jwt>"
  return open(__ENV.TOKENS_FILE || './tokens.txt').trim().split('\n').map((l) => {
    const i = l.indexOf(':');
    return { uid: l.slice(0, i), jwt: l.slice(i + 1) };
  });
});

export const options = {
  scenarios: {
    inbox: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: Number(__ENV.VUS || 100) },
        { duration: __ENV.DURATION || '10m', target: Number(__ENV.VUS || 100) },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    msg_delivery_ms: ['p(99)<1500', 'p(75)<400'],
    first_sync_ms: ['p(95)<2000'],
    send_fail: ['rate<0.01'],
  },
};

export default function () {
  const me = tokens[(__VU - 1) % tokens.length];
  const peer = tokens[__VU % tokens.length]; // ring topology: VU i messages VU i+1
  const url = `wss://${BASE}/api/inbox`;
  const params = { headers: { Authorization: `Bearer ${me.jwt}` } };
  const t0 = Date.now();

  ws.connect(url, params, (socket) => {
    let synced = false;

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', cursor: 0 }));
      // keepalive ping (hibernation-friendly)
      socket.setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), 30000);
      // periodic send to my peer; embed send-time for delivery measurement on
      // the peer's socket (body carries the timestamp).
      socket.setInterval(() => {
        const res = http.post(
          `https://${BASE}/api/msg/send`,
          JSON.stringify({ to: peer.uid, kind: 'text', body: `lt:${Date.now()}`, client_id: `${__VU}-${Date.now()}` }),
          { headers: { 'content-type': 'application/json', Authorization: `Bearer ${me.jwt}` } },
        );
        sendFail.add(res.status !== 200);
      }, MSG_INTERVAL_S * 1000);
    });

    socket.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'sync' && !synced) {
        synced = true;
        syncMs.add(Date.now() - t0);
        check(m, { 'sync has messages array': (x) => Array.isArray(x.messages) });
      }
      if (m.type === 'msg' && typeof m.body === 'string' && m.body.startsWith('lt:')) {
        const sentAt = Number(m.body.slice(3));
        if (sentAt > 0) deliveryMs.add(Date.now() - sentAt);
      }
    });

    socket.on('error', () => {});
    // hold the socket for the scenario duration
    socket.setTimeout(() => socket.close(), 9.5 * 60 * 1000);
  });

  sleep(1);
}
