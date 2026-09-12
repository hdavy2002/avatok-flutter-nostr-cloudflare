/*
 * sessionUpload — file attachments for in-session chat. [APP-ONLY-TX-1 2026-09-12]
 *
 * `Specs/RULEBOOK-PAID-SESSIONS.md` §7: the customer's browser may view,
 * listen, talk, chat **and upload**. This is the upload half. It deliberately
 * reuses the one byte-staging endpoint the site already has,
 * `POST /upload/public` (worker `routes/media.ts` — sha256 dedup, blocklist
 * gate, async Workers-AI scan, quota), exactly the way the listing wizard
 * uploads posters. No new route, no new bucket.
 *
 * Auth: the caller passes whatever `requireGuestAuth()` resolved. That is a
 * REAL Clerk session token (see lib/clerk.tsx's header — the HMAC "guest token"
 * is not authentication), and `/upload/public` gates on `requireUser`, which
 * accepts exactly that. A paying customer who signed in with an email code can
 * therefore upload with no extra grant and no dashboard account — nothing on
 * the worker side needed changing.
 *
 * NOTE on `web-has-no-messaging` (project memory): that owner decision bans a
 * buyer→creator MESSAGE BOX on public listing pages, where questions landed in
 * a table nobody read. This is not that. This chat exists only inside a
 * live/booked paid session, rides that session's own `StreamSessionDO` socket,
 * is seen by the creator in real time in the app, and dies with the session.
 */
import { API_BASE } from './config';
import { withTrace } from './analytics';

/** Owner-stated cap for a session-chat attachment. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Allow-list, mirrored by `sanitizeChatAttachment` in the DO (the authority). */
export const ATTACHMENT_MIME_ALLOW = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

/** `accept` attribute for the file input. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_MIME_ALLOW.join(',');

export interface ChatAttachment {
  url: string;
  name: string;
  size: number;
  mime: string;
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf', txt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Some browsers hand back an empty or generic `type` — fall back to the extension. */
export function attachmentMime(file: File): string | null {
  const declared = (file.type || '').toLowerCase();
  if ((ATTACHMENT_MIME_ALLOW as readonly string[]).includes(declared)) return declared;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const guess = EXT_MIME[ext];
  return guess ?? null;
}

export function isImageAttachment(mime: string): boolean {
  return /^image\//i.test(mime);
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export class AttachmentError extends Error {}

/**
 * Validate + upload one file, returning the descriptor to put on the chat
 * message as `attachment`. Throws `AttachmentError` with a human sentence.
 */
export async function uploadChatAttachment(file: File, jwt: string): Promise<ChatAttachment> {
  const mime = attachmentMime(file);
  if (!mime) throw new AttachmentError('That file type is not allowed here. Images, PDFs and documents only.');
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentError('That file is too large (max 25 MB).');
  if (!file.size) throw new AttachmentError('That file is empty.');

  let res: Response;
  try {
    res = await withTrace(() => fetch(`${API_BASE}/upload/public`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'x-content-type': mime,
        'x-file-name': file.name,
        'x-app': 'avatok',
      },
      body: file,
    }));
  } catch {
    throw new AttachmentError('Could not reach avaTOK to upload that file.');
  }
  if (!res.ok) {
    if (res.status === 413) throw new AttachmentError('That file is too large to store right now.');
    if (res.status === 403) throw new AttachmentError('That file was rejected by moderation.');
    throw new AttachmentError(`Could not upload that file (${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { url?: string };
  if (!body.url) throw new AttachmentError('Upload finished but no file came back. Try again.');
  return { url: body.url, name: file.name.slice(0, 120) || 'file', size: file.size, mime };
}
