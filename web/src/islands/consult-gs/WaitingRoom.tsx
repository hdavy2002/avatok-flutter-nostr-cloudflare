/*
 * WaitingRoom — the paid-consult lobby, [WAITROOM-WEB-1 2026-09-11]
 * (Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md WP4, RULEBOOK-PAID-SESSIONS
 * §3). This is the screen both parties sit on for the booked slot BEFORE any
 * GetStream media exists: the counterparty's avatar + name, "Waiting for
 * X…", the visitor's own local camera preview (the SAME stream PreJoin
 * acquired — never a second `getUserMedia`), the meter (countdown to start,
 * then time left), waiting-room chat over the `StreamSessionDO` socket, the
 * creator's own check-in line, and Leave.
 *
 * This component owns NO socket and makes NO auto-join decision — both are
 * the parent's (`ConsultRoomGS`), because the socket must survive this
 * component unmounting when the call goes live and remounting when the call
 * is left (RULEBOOK §3: "creator waits in the DO room by default... both
 * auto-join when both are present"; PLAN contract: "keep the socket").
 */
import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Spinner } from '../../components';
import { Countdown } from './Countdown';

export interface WaitingChatLine {
  id: string;
  from: string;
  text: string;
  mine: boolean;
}

export interface WaitingRoster {
  host: boolean;
  attendee: boolean;
}

export interface WaitingRoomProps {
  role: 'creator' | 'buyer';
  counterpartyName: string | null;
  counterpartyAvatar: string | null;
  startsAt: number;
  endsAt: number;
  /** `starts_at + sessionCreatorCheckInMin`. Null when WP1/WP2 haven't landed yet. */
  checkInBy: number | null;
  /** The exact MediaStream PreJoin acquired — kept alive, never re-requested here. */
  previewStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  wsStatus: 'connecting' | 'open' | 'reconnecting' | 'closed';
  roster: WaitingRoster;
  /**
   * [WAITROOM-WEB-2 fix 7] Epoch ms of the creator's first socket open —
   * the server's `host_checked_in_at` when known, else the parent's own
   * roster-history fallback. Null until any evidence exists.
   */
  hostCheckedInAt: number | null;
  chat: WaitingChatLine[];
  onSendChat: (text: string) => void;
  onLeave: () => void;
  /** [WAITROOM-WEB-2 fix 1] True after a deliberate Leave paused auto-join. */
  autoJoinPaused?: boolean;
  /** [WAITROOM-WEB-2 fix 1] Manual escape hatch for `autoJoinPaused`. */
  onRejoin?: () => void;
}

function fmtHM(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ms).toString();
  }
}

export function WaitingRoom({
  role,
  counterpartyName,
  counterpartyAvatar,
  startsAt,
  endsAt,
  checkInBy,
  previewStream,
  micOn,
  camOn,
  wsStatus,
  roster,
  hostCheckedInAt,
  chat,
  onSendChat,
  onLeave,
  autoJoinPaused,
  onRejoin,
}: WaitingRoomProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  // [WAITROOM-WEB-2 fix 7] see the `checkedInAt` comment below.
  const localCheckedInAtRef = useRef<number | null>(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const peerLabel = counterpartyName ?? (role === 'creator' ? 'your customer' : 'the creator');

  useEffect(() => {
    if (role === 'creator' && wsStatus === 'open' && localCheckedInAtRef.current == null) {
      localCheckedInAtRef.current = Date.now();
    }
  }, [role, wsStatus]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = previewStream;
      if (previewStream) void videoRef.current.play().catch(() => {});
    }
  }, [previewStream]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length]);

  const started = now >= startsAt;
  const meterTarget = started ? endsAt : startsAt;
  const meterLabel = started ? 'Time left' : 'Starts in';

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onSendChat(t);
    setDraft('');
  };

  // [WAITROOM-WEB-2 fix 7] "You're checked in" is a WINDOW, not just "the
  // socket happens to be open right now" — a creator whose connection drops
  // and reopens after `check_in_by` did not check in on time, even though
  // `wsStatus` would read 'open' again. Creator-only, since only the
  // creator's check-in has a deadline (RULEBOOK §2/§3). Falls back to this
  // component's own first-observed-open timestamp only until `hostCheckedInAt`
  // (server value or the parent's roster-history fallback) is known — a
  // ref, not `now`, so it latches once and never drifts forward on its own.
  const checkedInAt = hostCheckedInAt ?? localCheckedInAtRef.current;
  const checkedInOnTime = role === 'creator' && checkedInAt != null && (checkInBy == null || checkedInAt <= checkInBy);
  const checkInWindowClosed = role === 'creator' && !checkedInOnTime && checkInBy != null && now > checkInBy;
  // [WAITROOM-WEB-2 fix 6] The buyer's no-show line: the host is a no-show
  // the moment `check_in_by` passes without them, by presence alone
  // (`!roster.host`) — the terminal "no host ever seen" distinction lives in
  // the parent (ConsultRoomGS), which stops auto-join and starts polling for
  // the refund once that holds true.
  const hostIsNoShow = role === 'buyer' && checkInBy != null && now > checkInBy && !roster.host;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <Avatar src={counterpartyAvatar} name={counterpartyName} size={64} />
        <div>
          <h1 className="font-display font-semibold text-[24px] leading-tight text-ink">
            Waiting for {peerLabel}…
          </h1>
          <p className="mt-1 font-body font-bold text-[13px] text-inkMute">
            {roster && (role === 'creator' ? roster.attendee : roster.host) ? (
              <span className="text-mintInk">{peerLabel} is here — connecting you both…</span>
            ) : wsStatus === 'reconnecting' ? (
              'Reconnecting to the waiting room…'
            ) : (
              "We'll connect you both automatically the moment you're both here."
            )}
          </p>
        </div>
        <Countdown target={meterTarget} label={meterLabel} onZero={started ? undefined : () => setNow(Date.now())} />
      </div>

      {/* own local preview */}
      <div className="relative mx-auto aspect-[4/3] w-full max-w-xs overflow-hidden rounded-zine border-zine border-ink bg-ink shadow-zine">
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        {!previewStream && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper2">
            <Spinner size={22} />
          </div>
        )}
        {previewStream && !camOn && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/80 font-display font-semibold text-[14px] text-paper">
            Camera off
          </div>
        )}
        {previewStream && !micOn && (
          <span className="absolute bottom-2 left-2 rounded-zineBadge border-zine border-ink bg-coral px-2 py-1 font-mono font-bold text-[11px] text-white">
            Muted
          </span>
        )}
      </div>

      {/* creator check-in / customer no-show line */}
      {role === 'creator' ? (
        <div
          className={[
            'mx-auto rounded-zine border-zine px-4 py-2 text-center font-body font-bold text-[13px] shadow-zine-xs',
            checkedInOnTime ? 'border-ink bg-card text-mintInk' : 'border-ink bg-paper2 text-inkSoft',
          ].join(' ')}
        >
          {checkedInOnTime ? (
            "You're checked in ✓ — you'll be paid for this slot"
          ) : checkInWindowClosed ? (
            'Check-in window closed'
          ) : checkInBy ? (
            `Check in by ${fmtHM(checkInBy)}`
          ) : (
            'Connecting…'
          )}
        </div>
      ) : (
        hostIsNoShow && (
          <div className="mx-auto rounded-zine border-zine border-coral bg-card px-4 py-2 text-center font-body font-bold text-[13px] text-coral shadow-zine-error">
            {peerLabel} didn't show up — your payment is being refunded
          </div>
        )
      )}

      {/* [WAITROOM-WEB-2 fix 1] manual escape hatch after a deliberate Leave */}
      {autoJoinPaused && onRejoin && (
        <div className="mx-auto flex flex-col items-center gap-2 rounded-zine border-zine border-ink bg-paper2 px-4 py-3 text-center shadow-zine-xs">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            You left the call. We won't rejoin you automatically.
          </p>
          <Button variant="lime" label="Rejoin call" onClick={onRejoin} />
        </div>
      )}

      {/* chat */}
      <div className="flex flex-col gap-2 rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs">
        <div className="flex max-h-40 min-h-[3.5rem] flex-col gap-1 overflow-y-auto">
          {chat.length === 0 ? (
            <p className="font-body text-[13px] text-inkMute">No messages yet.</p>
          ) : (
            chat.map((l) => (
              <p key={l.id} className="font-body text-[13px] text-inkSoft">
                <span className={`font-bold ${l.mine ? 'text-blueInk' : 'text-ink'}`}>{l.from}:</span> {l.text}
              </p>
            ))
          )}
          <div ref={chatEndRef} />
        </div>
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            maxLength={500}
            placeholder="Message…"
            aria-label="Chat message"
            className="min-w-0 flex-1 rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body font-bold text-[14px] text-ink focus:outline-none focus:shadow-zine-focus"
          />
          <Button variant="blue" label="Send" onClick={send} />
        </div>
      </div>

      <div className="flex justify-center pt-1">
        <Button variant="ghost" label="Leave" onClick={onLeave} />
      </div>
    </div>
  );
}

export default WaitingRoom;
