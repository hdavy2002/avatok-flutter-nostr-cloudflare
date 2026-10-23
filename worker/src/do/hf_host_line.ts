// [HF-CALL-MODES-B] HfHostLineDO: one Durable Object per influencer (idFromName(hostUid)). It serialises every queue mutation (join, leave,
// line-free, mode, pause, sweep) and owns the break / dispatch / skip / expiry / WhatsApp-pacing alarms (sub-minute timers must be DO alarms:
// never a 1-minute cron). All logic is in lib/hf_queue_store.ts; this class is the mutex, the state in storage and the alarm.
// Internal only: reached through env.HF_HOST_LINE by routes/hf_queue.ts, lib/hf_queue_store.ts hooks and the 5-minute cron. Dark behind
// hfCallQueueEnabled: with it off every op answers {ok:false} / no-op.
import type { Env } from "../types";
import { trackException } from "../hooks";
import { HF_CALL_APP } from "../lib/hf_calls_store";
import {
  closeAll, freshLineState, joinQueue, leaveQueue, lineFree, modeChanged, nextAlarmAt, pauseChanged, tick,
  type LineOutcome, type LineResponse, type LineState,
} from "../lib/hf_queue_store";
import type { QueueSkipReason } from "../lib/hf_call_contracts";

const STATE_KEY = "line";
const res = (b: LineResponse, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

export class HfHostLineDO {
  private chain: Promise<unknown> = Promise.resolve();
  private hostUid = "";

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  /** One operation at a time: D1 awaits would otherwise interleave two joins / a join and an alarm. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<LineState> {
    const s = (await this.ctx.storage.get<LineState>(STATE_KEY)) ?? null;
    return { ...freshLineState(), ...(s ?? {}), joinPos: { ...(s?.joinPos ?? {}) } };
  }
  private async save(st: LineState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, st);
    await this.ctx.storage.put("hostUid", this.hostUid);
    const now = Date.now();
    const at = await nextAlarmAt(this.env, this.hostUid, st, now);
    if (at == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, now + 1));
  }

  async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.replace(/^\/+/, "");
    let body: Record<string, any> = {};
    try { body = (await req.json()) as Record<string, any>; } catch { body = {}; }
    const hostUid = String(body.hostUid ?? "");
    if (!hostUid) return res({ ok: false }, 400);
    this.hostUid = hostUid;
    return this.serial(async () => {
      try {
        const st = await this.load();
        const now = Date.now();
        let out: LineResponse;
        switch (op) {
          case "join": out = await joinQueue(this.env, hostUid, String(body.fanUid ?? ""), String(body.entryId ?? crypto.randomUUID()), st, now); break;
          case "leave": out = await leaveQueue(this.env, hostUid, String(body.fanUid ?? ""), body.entryId ? String(body.entryId) : undefined, st, now); break;
          case "line-free": out = await lineFree(this.env, hostUid, String(body.callId ?? ""), (body.outcome as LineOutcome) ?? "failed", st, now); break;
          case "mode": out = await modeChanged(this.env, hostUid, String(body.mode ?? "offline"), (body.reason as QueueSkipReason) ?? "host_offline", st, now); break;
          case "pause": out = await pauseChanged(this.env, hostUid, body.paused === true, body.by === "system" ? "system" : "host", st, now); break;
          case "close": out = await closeAll(this.env, hostUid, (body.reason as QueueSkipReason) ?? "host_offline", st, now); break;
          case "sweep": await tick(this.env, hostUid, st, now, true); out = { ok: true }; break;
          default: return res({ ok: false }, 404);
        }
        // Send what this op queued right away (paced) and re-arm the alarm.
        await tick(this.env, hostUid, st, Date.now(), false);
        await this.save(st);
        return res(out);
      } catch (e) {
        await trackException(this.env, e, { route: "hf_host_line", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue", op } }).catch(() => undefined);
        return res({ ok: false }, 500);
      }
    });
  }

  /** Break over / retry / expiry / next WhatsApp: tick() does whatever is due and nextAlarmAt() re-arms. */
  async alarm(): Promise<void> {
    await this.serial(async () => {
      try {
        const stored = await this.ctx.storage.get<string>("hostUid");
        if (stored) this.hostUid = stored;
        if (!this.hostUid) return;
        const st = await this.load();
        await tick(this.env, this.hostUid, st, Date.now(), false);
        await this.save(st);
      } catch (e) {
        await trackException(this.env, e, { route: "hf_host_line.alarm", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_queue" } }).catch(() => undefined);
        try { await this.ctx.storage.setAlarm(Date.now() + 30_000); } catch { /* the 5-minute sweep is the net */ }
      }
    });
  }
}
