// [HF-SUPPORT-DESK] Types for the support desk. They follow HF-SUPPORT-CONTRACT.md (v1, 2026-10-29).
// Fields the contract leaves open are optional here and read through normalize.ts, so a small difference in the
// worker's answer degrades the screen instead of crashing it.

export type CategorySlug = 'calls' | 'wallet' | 'withdraw' | 'bookings' | 'influencer' | 'app' | 'report' | 'other';

/** The 8 categories, same order and labels as the app's Contact Support form. */
export const CATEGORIES: { slug: CategorySlug; label: string; short: string }[] = [
  { slug: 'calls', label: 'Calls', short: 'Calls' },
  { slug: 'wallet', label: 'Wallet & top-ups', short: 'Wallet' },
  { slug: 'withdraw', label: 'Withdraw to UPI', short: 'Withdraw' },
  { slug: 'bookings', label: 'Bookings', short: 'Bookings' },
  { slug: 'influencer', label: 'Influencer account', short: 'Influencer' },
  { slug: 'app', label: 'App problem', short: 'App problem' },
  { slug: 'report', label: 'Report someone', short: 'Report someone' },
  { slug: 'other', label: 'Other', short: 'Other' },
];

export const categoryLabel = (slug: string | null | undefined): string =>
  CATEGORIES.find((c) => c.slug === slug)?.label ?? (slug ? slug : 'Other');
export const categoryShort = (slug: string | null | undefined): string =>
  CATEGORIES.find((c) => c.slug === slug)?.short ?? (slug ? slug : 'Other');

export type Status = 'new' | 'open' | 'waiting' | 'on_hold' | 'solved' | 'closed' | 'spam' | 'trash';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];
export type StaffRole = 'admin' | 'agent' | 'viewer';
export type CustomerRole = 'fan' | 'influencer' | 'unverified';

export interface Attachment { id: string; name: string; size: number; contentType: string }

/** ---------- customer API ---------- */
export interface CustomerTicketRow {
  number: string; subject: string; category: string; status: Status; statusLabel: string;
  preview: string; updatedAt: number | string; unread: boolean;
}
export interface CustomerMessage {
  id: string; author: 'customer' | 'support' | 'system'; authorName: string; text: string; html?: string;
  createdAt: number | string; attachments: Attachment[];
}
export interface CustomerTicketDetail {
  ticket: {
    number: string; subject: string; category: string; status: Status; statusLabel: string;
    createdAt: number | string; updatedAt: number | string; canReopen: boolean;
  };
  messages: CustomerMessage[];
}
export interface NewTicketInput {
  category: CategorySlug; subject: string; message: string; attachmentIds?: string[];
  meta?: { appVersion?: string; build?: string; device?: string; os?: string; lastScreen?: string; platform?: string };
}

/** ---------- admin API ---------- */
export interface SlaInfo { dueAt: number | string | null; state: 'ok' | 'amber' | 'red' }
export interface AdminCustomerLite { name: string; role: CustomerRole; uid?: string | null; email?: string | null }
export interface AdminRow {
  number: string; customer: AdminCustomerLite; subject: string; preview: string; category: string; priority: Priority;
  assignee: { uid: string; name: string } | null; sla: SlaInfo; updatedAt: number | string; unread: boolean;
  status?: Status; channel?: string;
}
export type FolderKey = 'unassigned' | 'mine' | 'open' | 'waiting' | 'on_hold' | 'solved' | 'closed' | 'spam' | 'trash';
export const FOLDERS: { key: FolderKey; label: string }[] = [
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'mine', label: 'My tickets' },
  { key: 'open', label: 'All open' },
  { key: 'waiting', label: 'Waiting on customer' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'solved', label: 'Solved' },
  { key: 'closed', label: 'Closed' },
  { key: 'spam', label: 'Spam' },
  { key: 'trash', label: 'Trash' },
];
export interface AdminList { rows: AdminRow[]; counts: Partial<Record<FolderKey, number>>; nextCursor: string | null; me?: { uid?: string; name?: string; role?: StaffRole } }

export interface AdminMessage {
  id: string; kind: 'customer' | 'support' | 'note' | 'system'; authorName: string; authorEmail?: string | null;
  text: string; html?: string; createdAt: number | string; attachments: Attachment[];
  delivery?: 'queued' | 'sent' | 'delivered' | 'failed' | string | null;
}
export interface TicketEvent { id: string; text: string; createdAt: number | string }
export interface CustomerPanel {
  uid?: string | null; name: string; handle?: string | null; role: CustomerRole; verified?: boolean; whatsappMasked?: string | null;
  email?: string | null; joinedAt?: number | string | null; walletRupees?: number | null; pendingWithdrawRupees?: number | null;
  calls30d?: number | null; strikes?: number | null;
  recentMoney: { label: string; amountRupees: number; at?: number | string | null }[];
  otherTickets: { number: string; subject: string; status: string }[];
}
export interface Viewer { uid?: string; name: string; me?: boolean }
export interface AdminDetail {
  ticket: {
    number: string; subject: string; category: string; status: Status; priority: Priority; channel: string;
    assignee: { uid: string; name: string } | null; sla: SlaInfo; createdAt: number | string; updatedAt: number | string;
    snoozeUntil?: number | string | null;
  };
  messages: AdminMessage[];
  events: TicketEvent[];
  customer: CustomerPanel;
  viewers: Viewer[];
}

export interface CannedReply { id: string; title: string; body: string }
export interface StaffMember { id: string; uid?: string | null; email: string; name?: string | null; role: StaffRole }
export interface SignatureDoc { html: string; useFor: 'team' | 'personal' }

export interface BusinessHours { days: number[]; from: string; to: string; tz: string }
export interface Holiday { date: string; label: string }
export interface AutomationRule { id: string; category: CategorySlug; assigneeUid: string | null; priority: Priority | null }
export interface SupportSettings {
  alert_whatsapp?: string; whatsapp_min_interval_ms?: number;
  business_hours?: BusinessHours; holidays?: Holiday[]; automations?: AutomationRule[];
  [k: string]: unknown;
}

export interface QueueStat { name: string; what?: string; waiting: number; perMin: number; failed24h: number; oldestSec: number | null; paused?: boolean }
export interface FailedJob { id: string; queue: string; what: string; reason: string; at: number | string }
export interface Suppression { email: string; reason?: string; at?: number | string }
export interface BlockedSender { email?: string; domain?: string; at?: number | string; by?: string }

export interface ReportData {
  range: string;
  totals: { created: number; solved: number; open: number; firstReplyMinutes: number | null; slaMetPct: number | null };
  perDay: { day: string; created: number; solved: number }[];
  byCategory: { category: string; count: number }[];
}
