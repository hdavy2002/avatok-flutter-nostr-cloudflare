// [HF-SUPPORT-DESK] The support desk's API client. Real calls go to the Worker (api.<domain>) with the Clerk session JWT as
// `Authorization: Bearer`, exactly like the rest of the site. When the build is made with PUBLIC_SUPPORT_MOCK=1 every call is
// answered by ./mock.ts instead (no network, no sign-in), so all screens can be previewed before the worker routes exist.
//
// TO TURN MOCKS OFF: build without PUBLIC_SUPPORT_MOCK (the default). Nothing else to change; the mock module is not
// included in a normal build.
import { API_BASE } from '../../lib/env';
import { getActiveTokenWaited } from '../../lib/clerk';
import { fileNameHeader } from '../../lib/uploadHeaders';
import type {
  AdminDetail, AdminList, AdminMessage, AdminRow, Attachment, BlockedSender, CannedReply, CategorySlug, CustomerMessage, CustomerPanel,
  CustomerTicketDetail, CustomerTicketRow, FailedJob, FolderKey, NewTicketInput, Priority, QueueStat, ReportData, SignatureDoc,
  StaffMember, StaffRole, Status, Suppression, SupportSettings, TicketEvent, Viewer,
} from './types';

export const MOCK: boolean = import.meta.env.PUBLIC_SUPPORT_MOCK === '1';

export class SupportApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

type Query = Record<string, string | number | boolean | null | undefined>;
interface CallOpts { method?: string; query?: Query; body?: unknown; signal?: AbortSignal }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function url(path: string, query?: Query): string {
  const u = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function errCode(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) return String((body as { error: unknown }).error || fallback);
  return fallback;
}

async function realCall(path: string, opts: CallOpts): Promise<unknown> {
  const method = opts.method ?? 'GET';
  const run = async (token: string | null) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    return fetch(url(path, opts.query), { method, headers, body, signal: opts.signal, cache: 'no-store' });
  };
  let token = await getActiveTokenWaited(5000);
  let res = await run(token);
  if (res.status === 401) {
    // A Clerk session JWT lives about a minute and the desk stays open for hours: one retry with a freshly minted token.
    token = await getActiveTokenWaited(5000, { skipCache: true });
    if (token) res = await run(token);
  }
  const data = await parse(res);
  if (!res.ok) throw new SupportApiError(res.status, errCode(data, res.statusText || 'request_failed'));
  return data;
}

async function mockCall(path: string, opts: CallOpts): Promise<unknown> {
  const mod = await import('./mock');
  await sleep(90 + Math.random() * 140);
  const res = mod.mockHandle(opts.method ?? 'GET', path, Object.fromEntries(Object.entries(opts.query ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])), (opts.body ?? {}) as Record<string, unknown>);
  if (res.status >= 400) throw new SupportApiError(res.status, errCode(res.data, 'error'));
  return res.data;
}

export async function call<T = Record<string, unknown>>(path: string, opts: CallOpts = {}): Promise<T> {
  return (MOCK ? await mockCall(path, opts) : await realCall(path, opts)) as T;
}

/** The sentence a person sees for an API failure. */
export function errMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof SupportApiError) {
    const m: Record<string, string> = {
      forbidden: 'You do not have permission to do that.',
      read_only: 'You have read-only access, so you cannot change tickets.',
      no_session: 'Your session has ended. Please sign in again.',
      not_found: 'That could not be found. It may have been moved or deleted.',
      rate_limited: 'You have reached the limit of 5 new tickets a day. Please reply to an open ticket instead.',
      too_many_tickets: 'You have reached the limit of 5 new tickets a day. Please reply to an open ticket instead.',
      file_type_not_allowed: 'That file type is not allowed. Use images or PDFs.',
      file_too_large: 'That file is too large. Each file can be up to 10 MB.',
      ticket_closed: 'This ticket is closed. Please open a new ticket.',
      duplicate: 'You already sent this exact message a moment ago.',
    };
    if (m[e.code]) return m[e.code];
    if (e.status === 403) return m.forbidden;
    if (e.status === 429) return 'Too many requests. Please wait a minute and try again.';
    if (e.status >= 500) return 'Our server had a problem. Please try again in a moment.';
  }
  if (e instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  return fallback;
}
export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/* ── attachments ────────────────────────────────────────────────────────── */
const BLOCKED_EXT = /\.(exe|apk|bat|cmd|com|js|jar|msi|scr|vbs|zip|rar|7z|gz|tar)$/i;
export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_MESSAGE = 25 * 1024 * 1024;

/** null = fine, otherwise the sentence to show. Images and PDFs only, 10 MB each, 25 MB per message. */
export function validateFiles(incoming: File[], existing: { size: number }[] = []): string | null {
  let total = existing.reduce((a, b) => a + b.size, 0);
  for (const f of incoming) {
    if (BLOCKED_EXT.test(f.name) || !(f.type.startsWith('image/') || f.type === 'application/pdf')) return `${f.name}: only images and PDFs can be attached.`;
    if (f.size > MAX_FILE) return `${f.name} is larger than 10 MB.`;
    total += f.size;
  }
  if (total > MAX_MESSAGE) return 'Attachments can add up to 25 MB per message.';
  return null;
}

export interface Uploaded { id: string; name: string; size: number; url?: string }

export async function uploadAttachment(file: File, purpose?: 'signature'): Promise<Uploaded> {
  if (MOCK) {
    const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
    const r = await call<{ id: string; name: string; size: number; url?: string }>('/api/hf/support/attachments', { method: 'POST', body: { __name: file.name, __size: file.size, __dataUrl: purpose ? dataUrl : undefined } });
    return { id: r.id, name: file.name, size: file.size, url: r.url };
  }
  const send = async (token: string | null) => fetch(url('/api/hf/support/attachments', purpose ? { purpose } : undefined), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': file.type || 'application/octet-stream',
      // Percent-encoded: header values cannot carry non-ASCII (Devanagari file names would throw before the request leaves).
      'x-file-name': fileNameHeader(file.name),
    },
    body: file,
  });
  let token = await getActiveTokenWaited(5000);
  let res = await send(token);
  if (res.status === 401) { token = await getActiveTokenWaited(5000, { skipCache: true }); if (token) res = await send(token); }
  const data = (await parse(res)) as { id?: string; name?: string; size?: number; url?: string; error?: string };
  if (!res.ok || !data.id) throw new SupportApiError(res.status, errCode(data, 'upload_failed'));
  return { id: data.id, name: data.name ?? file.name, size: data.size ?? file.size, url: data.url };
}

/** Open an attachment (the file endpoint needs the session, so it is fetched with the token and shown from a blob). */
export async function openAttachment(a: Attachment): Promise<void> {
  const win = window.open('', '_blank');
  try {
    if (MOCK) {
      const blob = new Blob([`Preview attachment: ${a.name}`], { type: 'text/plain' });
      const u = URL.createObjectURL(blob);
      if (win) win.location.href = u;
      return;
    }
    const token = await getActiveTokenWaited(5000);
    const res = await fetch(url(`/api/hf/support/attachments/${encodeURIComponent(a.id)}`), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new SupportApiError(res.status, 'download_failed');
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    if (win) win.location.href = u; else window.location.href = u;
    setTimeout(() => URL.revokeObjectURL(u), 120_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

/* ── normalisers (the contract leaves some names open; read defensively) ── */
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
type R = Record<string, unknown>;

function normAtt(a: unknown): Attachment {
  const o = (a ?? {}) as R;
  return { id: str(o.id), name: str(o.name, 'file'), size: num(o.size) ?? 0, contentType: str(o.contentType ?? o.type) };
}

function normRow(r: unknown): AdminRow {
  const o = (r ?? {}) as R;
  const c = (o.customer ?? {}) as R;
  const a = o.assignee as R | string | null | undefined;
  const sla = (o.sla ?? {}) as R;
  return {
    number: str(o.number), subject: str(o.subject), preview: str(o.preview), category: str(o.category, 'other'),
    customer: { name: str(c.name ?? o.customerName, 'Unknown'), role: (str(c.role ?? o.role, 'unverified') as AdminRow['customer']['role']), uid: (c.uid as string | null | undefined) ?? null, email: str(c.email) || null },
    priority: (str(o.priority, 'normal') as Priority),
    assignee: a && typeof a === 'object' ? { uid: str(a.uid), name: str(a.name, 'Someone') } : typeof a === 'string' && a ? { uid: a, name: a } : null,
    sla: { dueAt: (sla.dueAt as number | string | null) ?? null, state: (str(sla.state, 'ok') as 'ok' | 'amber' | 'red') },
    updatedAt: (o.updatedAt as number | string) ?? 0, unread: !!o.unread, status: o.status as Status | undefined, channel: str(o.channel) || undefined,
  };
}

export function normList(r: unknown): AdminList {
  const o = (r ?? {}) as R;
  const rows = arr(o.tickets ?? o.items ?? o.rows).map(normRow);
  const counts = (o.counts ?? o.folderCounts ?? {}) as AdminList['counts'];
  const me = o.me as AdminList['me'];
  return { rows, counts, nextCursor: (o.nextCursor ?? o.cursor ?? o.next_cursor ?? null) as string | null, me };
}

function normMsg(m: unknown): AdminMessage {
  const o = (m ?? {}) as R;
  const author = str(o.author);
  const kind: AdminMessage['kind'] = o.kind === 'note' || o.internal === true || o.isNote === true || o.isInternal === true || author === 'note' || author === 'internal'
    ? 'note'
    : ((['customer', 'support', 'system'].includes(str(o.kind)) ? str(o.kind) : ['customer', 'support', 'system'].includes(author) ? author : 'support') as AdminMessage['kind']);
  const out = (o.outbox ?? {}) as R;
  return {
    id: str(o.id), kind, authorName: str(o.authorName ?? o.name, kind === 'customer' ? 'Customer' : 'Support'), authorEmail: str(o.authorEmail ?? o.email) || null,
    text: str(o.text), html: o.html ? str(o.html) : undefined, createdAt: (o.createdAt as number | string) ?? 0,
    attachments: arr(o.attachments).map(normAtt), delivery: str(o.delivery ?? o.deliveryState ?? out.state) || null,
  };
}

export function normDetail(r: unknown): AdminDetail {
  const o = (r ?? {}) as R;
  const t = (o.ticket ?? {}) as R;
  const c = (o.customer ?? {}) as R;
  const a = t.assignee as R | null | undefined;
  const sla = (t.sla ?? {}) as R;
  const customer: CustomerPanel = {
    uid: (c.uid as string | null | undefined) ?? null, name: str(c.name, 'Unknown'), handle: str(c.handle) || null,
    role: str(c.role, 'unverified') as CustomerPanel['role'], verified: c.verified !== false, whatsappMasked: str(c.whatsappMasked) || null, email: str(c.email) || null,
    joinedAt: (c.joinedAt as number | string | null | undefined) ?? null, walletRupees: num(c.walletRupees), pendingWithdrawRupees: num(c.pendingWithdrawRupees),
    calls30d: num(c.calls30d), strikes: num(c.strikes),
    recentMoney: arr<R>(c.recentMoney).map((x) => ({ label: str(x.label ?? x.title), amountRupees: num(x.amountRupees ?? x.amount) ?? 0, at: (x.at as number | string | null | undefined) ?? null })),
    otherTickets: arr<R>(c.otherTickets).map((x) => ({ number: str(x.number), subject: str(x.subject), status: str(x.statusLabel ?? x.status) })),
  };
  return {
    ticket: {
      number: str(t.number), subject: str(t.subject), category: str(t.category, 'other'), status: str(t.status, 'open') as Status, priority: str(t.priority, 'normal') as Priority,
      channel: str(t.channel, 'Email'), assignee: a ? { uid: str(a.uid), name: str(a.name, 'Someone') } : null,
      sla: { dueAt: (sla.dueAt as number | string | null) ?? null, state: str(sla.state, 'ok') as 'ok' | 'amber' | 'red' },
      createdAt: (t.createdAt as number | string) ?? 0, updatedAt: (t.updatedAt as number | string) ?? 0, snoozeUntil: (t.snoozeUntil as number | string | null | undefined) ?? null,
    },
    messages: arr(o.messages).map(normMsg),
    events: arr<R>(o.events).map((e, i): TicketEvent => ({ id: str(e.id, `e${i}`), text: str(e.text ?? e.label ?? e.type), createdAt: (e.createdAt ?? e.at ?? 0) as number | string })),
    customer,
    viewers: arr<R>(o.viewers).map((v): Viewer => ({ uid: str(v.uid) || undefined, name: str(v.name, 'Someone'), me: v.me === true })),
  };
}

/* ── customer API ───────────────────────────────────────────────────────── */
export const customerApi = {
  list: async (status: 'open' | 'solved' | 'closed' | 'all' = 'all', signal?: AbortSignal): Promise<CustomerTicketRow[]> =>
    arr<CustomerTicketRow>((await call<R>('/api/hf/support/tickets', { query: { status }, signal })).tickets),
  create: async (input: NewTicketInput): Promise<{ number: string }> => {
    const r = await call<{ ticket?: { number: string } }>('/api/hf/support/tickets', { method: 'POST', body: input });
    return { number: r.ticket?.number ?? '' };
  },
  get: async (number: string, signal?: AbortSignal): Promise<CustomerTicketDetail> => {
    const r = await call<R>(`/api/hf/support/tickets/${encodeURIComponent(number)}`, { signal });
    const t = (r.ticket ?? {}) as R;
    return {
      ticket: {
        number: str(t.number), subject: str(t.subject), category: str(t.category, 'other'), status: str(t.status, 'open') as Status, statusLabel: str(t.statusLabel, 'Open'),
        createdAt: (t.createdAt as number | string) ?? 0, updatedAt: (t.updatedAt as number | string) ?? 0, canReopen: !!t.canReopen,
      },
      messages: arr<R>(r.messages).map((m): CustomerMessage => ({
        id: str(m.id), author: (['customer', 'support', 'system'].includes(str(m.author)) ? str(m.author) : 'support') as CustomerMessage['author'], authorName: str(m.authorName),
        text: str(m.text), html: m.html ? str(m.html) : undefined, createdAt: (m.createdAt as number | string) ?? 0, attachments: arr(m.attachments).map(normAtt),
      })),
    };
  },
  reply: (number: string, message: string, attachmentIds: string[] = []) =>
    call(`/api/hf/support/tickets/${encodeURIComponent(number)}/reply`, { method: 'POST', body: { message, attachmentIds } }),
  solve: (number: string) => call(`/api/hf/support/tickets/${encodeURIComponent(number)}/solve`, { method: 'POST', body: {} }),
  reopen: (number: string) => call(`/api/hf/support/tickets/${encodeURIComponent(number)}/reopen`, { method: 'POST', body: {} }),
};

/* ── admin API ──────────────────────────────────────────────────────────── */
const A = '/api/admin/hf/support';
const tk = (n: string) => `${A}/tickets/${encodeURIComponent(n)}`;
export interface ListParams { folder: FolderKey | 'all'; q?: string; category?: string; priority?: string; channel?: string; assignee?: string; cursor?: string }

export const adminApi = {
  /** Also the "am I staff?" probe: any 2xx means staff, a 403 means customer. */
  list: async (p: ListParams, signal?: AbortSignal): Promise<AdminList> => normList(await call(`${A}/tickets`, { query: { ...p }, signal })),
  ticket: async (n: string, signal?: AbortSignal): Promise<AdminDetail> => normDetail(await call(tk(n), { signal })),
  reply: (n: string, b: { html: string; text: string; attachmentIds?: string[]; setStatus?: Status }) => call<{ delivery?: string }>(`${tk(n)}/reply`, { method: 'POST', body: b }),
  note: (n: string, text: string) => call(`${tk(n)}/note`, { method: 'POST', body: { text } }),
  patch: (n: string, b: { status?: Status; priority?: Priority; category?: CategorySlug | string; assigneeUid?: string | null; snoozeUntil?: number | null }) => call(tk(n), { method: 'PATCH', body: b }),
  merge: (n: string, into: string) => call(`${tk(n)}/merge`, { method: 'POST', body: { into } }),
  split: (n: string, messageId: string) => call<{ number?: string }>(`${tk(n)}/split`, { method: 'POST', body: { messageId } }),
  spam: (n: string) => call(`${tk(n)}/spam`, { method: 'POST', body: {} }),
  viewing: (n: string) => call(`${tk(n)}/viewing`, { method: 'POST', body: {} }),
  block: (b: { email?: string; domain?: string }) => call(`${A}/block`, { method: 'POST', body: b }),
  blocked: async (): Promise<BlockedSender[]> => arr<BlockedSender>((await call<R>(`${A}/block`)).items),
  unblock: (b: { email?: string; domain?: string }) => call(`${A}/block`, { method: 'DELETE', query: b }),
  bulk: (numbers: string[], action: string, value?: string) => call(`${A}/bulk`, { method: 'POST', body: { numbers, action, value } }),

  canned: async (): Promise<CannedReply[]> => arr<R>((await call<R>(`${A}/canned`)).items).map((c) => ({ id: str(c.id), title: str(c.title ?? c.name), body: str(c.body ?? c.text) })),
  saveCanned: (c: { id?: string; title: string; body: string }) => (c.id ? call(`${A}/canned/${encodeURIComponent(c.id)}`, { method: 'PUT', body: c }) : call(`${A}/canned`, { method: 'POST', body: c })),
  deleteCanned: (id: string) => call(`${A}/canned/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  signature: async (scope: 'team' | 'me'): Promise<SignatureDoc> => {
    const r = await call<R>(`${A}/signature`, { query: { scope } });
    return { html: str(r.html), useFor: r.useFor === 'personal' ? 'personal' : 'team' };
  },
  saveSignature: (scope: 'team' | 'me', b: SignatureDoc) => call(`${A}/signature`, { method: 'PUT', query: { scope }, body: b }),
  testSignature: (b: SignatureDoc) => call(`${A}/signature/test`, { method: 'POST', body: b }),

  settings: async (): Promise<SupportSettings> => {
    const r = await call<R>(`${A}/settings`);
    return ((r.settings as SupportSettings | undefined) ?? (r as SupportSettings)) as SupportSettings;
  },
  saveSettings: (patch: Partial<SupportSettings>) => call(`${A}/settings`, { method: 'PUT', body: patch }),

  staff: async (): Promise<StaffMember[]> => arr<R>((await call<R>(`${A}/staff`)).items ?? []).map((s) => ({ id: str(s.id ?? s.uid ?? s.email), uid: (s.uid as string | null | undefined) ?? null, email: str(s.email), name: str(s.name) || null, role: str(s.role, 'agent') as StaffRole })),
  addStaff: (email: string, role: StaffRole) => call(`${A}/staff`, { method: 'POST', body: { email, role } }),
  removeStaff: (id: string) => call(`${A}/staff/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  queues: async (signal?: AbortSignal): Promise<QueueStat[]> =>
    arr<R>((await call<R>(`${A}/queues`, { signal })).queues ?? []).map((q) => ({
      name: str(q.name), what: str(q.what) || undefined, waiting: num(q.waiting) ?? 0, perMin: num(q.perMin ?? q.doneRate ?? q.rate) ?? 0, failed24h: num(q.failed24h ?? q.failed) ?? 0,
      oldestSec: num(q.oldestSec ?? q.oldestSeconds), paused: q.paused === true,
    })),
  failed: async (): Promise<FailedJob[]> => arr<R>((await call<R>(`${A}/queues/failed`)).items).map((f) => ({ id: str(f.id), queue: str(f.queue), what: str(f.what ?? f.label), reason: str(f.reason ?? f.error), at: (f.at ?? f.failedAt ?? 0) as number | string })),
  retry: (id: string) => call(`${A}/queues/failed/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }),
  discard: (id: string) => call(`${A}/queues/failed/${encodeURIComponent(id)}/discard`, { method: 'POST', body: {} }),
  suppressions: async (): Promise<Suppression[]> => arr<R>((await call<R>(`${A}/queues/suppressions`)).items).map((s) => ({ email: str(s.email ?? s.address), reason: str(s.reason) || undefined, at: (s.at ?? s.createdAt) as number | string | undefined })),
  removeSuppression: (email: string) => call(`${A}/queues/suppressions`, { method: 'DELETE', query: { email } }),

  reports: async (range: string): Promise<ReportData> => {
    const r = await call<R>(`${A}/reports`, { query: { range } });
    const t = (r.totals ?? {}) as R;
    return {
      range: str(r.range, range),
      totals: { created: num(t.created) ?? 0, solved: num(t.solved) ?? 0, open: num(t.open) ?? 0, firstReplyMinutes: num(t.firstReplyMinutes), slaMetPct: num(t.slaMetPct) },
      perDay: arr<R>(r.perDay).map((d) => ({ day: str(d.day), created: num(d.created) ?? 0, solved: num(d.solved) ?? 0 })),
      byCategory: arr<R>(r.byCategory).map((d) => ({ category: str(d.category), count: num(d.count) ?? 0 })),
    };
  },
};
