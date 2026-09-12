/*
 * SessionChat — the customer's side chat for a paid 1:1, with file upload.
 * [APP-ONLY-TX-1 2026-09-12]
 *
 * `Specs/RULEBOOK-PAID-SESSIONS.md` §7: the browser is the CUSTOMER's surface
 * and what he may do there is "view, listen, talk, chat, upload". This panel is
 * the chat + upload half, and it renders identically in the waiting room
 * (WaitingRoom) and during the call (CallStage) so the conversation does not
 * visibly restart when media opens.
 *
 * Transport: it owns none. Lines come in as props and go out through
 * `onSend` — the parent (ConsultRoomGS) owns the one `StreamSessionDO` socket
 * that must survive this component unmounting when the call goes live
 * (RULEBOOK §3). Attachments ride the same `chat` message as
 * `{type:'chat', text, attachment:{url,name,size,mime}}`; the DO validates and
 * relays the descriptor (worker/src/do/stream_session.ts,
 * `sanitizeChatAttachment`) and the creator's app renders it as a tappable
 * link (app/lib/core/commercial_waiting_room_api.dart).
 *
 * This is NOT the web messenger `web-has-no-messaging` forbids: it exists only
 * inside a session the customer paid for and dies with it. See lib/sessionUpload.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import {
  ATTACHMENT_ACCEPT,
  AttachmentError,
  fmtBytes,
  isImageAttachment,
  uploadChatAttachment,
  type ChatAttachment,
} from '../../lib/sessionUpload';

export interface SessionChatLine {
  id: string;
  from: string;
  text: string;
  mine: boolean;
  attachment?: ChatAttachment | null;
}

export interface SessionChatProps {
  lines: SessionChatLine[];
  onSend: (text: string, attachment?: ChatAttachment | null) => void;
  /** Session JWT used to authenticate the upload as this (guest) customer. */
  jwt: string | null;
  disabled?: boolean;
  /** For `session_chat_attachment_sent`. */
  context: { bookingId?: string | null; listingId?: string | null; surface: string; role?: string | null };
  /** Fills the available height (call stage) rather than a fixed lobby box. */
  fill?: boolean;
}

export function AttachmentBubble({ attachment }: { attachment: ChatAttachment }) {
  const isImage = isImageAttachment(attachment.mime);
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 flex max-w-full items-center gap-2 rounded-zineSm border-zine border-ink bg-paper px-2 py-1.5 no-underline shadow-zine-xs"
    >
      {isImage ? (
        <img
          src={attachment.url}
          alt={attachment.name}
          loading="lazy"
          className="h-12 w-12 shrink-0 rounded-zineSm border-zine border-ink object-cover"
        />
      ) : (
        <span aria-hidden className="text-[18px] leading-none">📎</span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-body text-[13px] font-bold text-blueInk underline">{attachment.name}</span>
        {attachment.size > 0 && (
          <span className="block font-mono text-[11px] font-bold uppercase tracking-[0.04em] text-inkMute">
            {fmtBytes(attachment.size)}
          </span>
        )}
      </span>
    </a>
  );
}

export function SessionChat({ lines, onSend, jwt, disabled, context, fill }: SessionChatProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const send = () => {
    const t = draft.trim();
    if (!t || disabled) return;
    onSend(t, null);
    setDraft('');
  };

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file || disabled || busy) return;
    if (!jwt) {
      setError('Please reload the page and try that upload again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const attachment = await uploadChatAttachment(file, jwt);
      // The caption (if the customer typed one) goes with the file, so the
      // creator sees one line, not two.
      const caption = draft.trim().slice(0, 500);
      onSend(caption, attachment);
      setDraft('');
      try {
        capture('session_chat_attachment_sent', {
          booking_id: context.bookingId ?? null,
          listing_id: context.listingId ?? null,
          surface: context.surface,
          role: context.role ?? null,
          mime: attachment.mime,
          bytes: attachment.size,
          is_image: isImageAttachment(attachment.mime),
        });
      } catch {
        /* best-effort */
      }
    } catch (e) {
      setError(e instanceof AttachmentError ? e.message : 'Could not upload that file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={[
        'flex min-h-0 flex-col gap-2 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs',
        fill ? 'h-full' : '',
      ].join(' ')}
    >
      <div className="font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-inkMute">Chat</div>
      <div className={['flex min-h-[3.5rem] flex-col gap-1 overflow-y-auto', fill ? 'flex-1' : 'max-h-56'].join(' ')}>
        {lines.length === 0 ? (
          <p className="font-body text-[13px] text-inkMute">No messages yet. You can send a file too.</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="font-body text-[13px] text-inkSoft">
              {(l.text || !l.attachment) && (
                <p>
                  <span className={`font-bold ${l.mine ? 'text-blueInk' : 'text-ink'}`}>{l.from}:</span> {l.text}
                </p>
              )}
              {l.attachment && (
                <>
                  {!l.text && (
                    <p>
                      <span className={`font-bold ${l.mine ? 'text-blueInk' : 'text-ink'}`}>{l.from}:</span>{' '}
                      <span className="text-inkMute">sent a file</span>
                    </p>
                  )}
                  <AttachmentBubble attachment={l.attachment} />
                </>
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <p className="rounded-zineSm border-zine border-coral bg-paper px-2 py-1 font-body text-[12px] font-bold text-coral">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          hidden
          onChange={(e) => void pick(e.target.files)}
        />
        <button
          type="button"
          aria-label="Attach a file"
          title="Attach a file (max 25 MB)"
          disabled={disabled || busy}
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono text-[14px] font-bold text-ink shadow-zine-xs disabled:opacity-50"
        >
          {busy ? '…' : '📎'}
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          maxLength={500}
          disabled={disabled}
          placeholder={disabled ? 'Chat unavailable' : 'Message…'}
          aria-label="Chat message"
          className="min-w-0 flex-1 rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body text-[14px] font-bold text-ink focus:outline-none focus:shadow-zine-focus disabled:bg-paper2 disabled:text-inkMute"
        />
        <button
          type="button"
          onClick={send}
          disabled={disabled || !draft.trim()}
          className="shrink-0 rounded-full border-zine border-ink bg-blue px-4 py-2 font-display text-[15px] font-semibold text-ink shadow-zine-sm disabled:border-inkMute disabled:bg-paper2 disabled:text-inkMute disabled:shadow-none"
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default SessionChat;
