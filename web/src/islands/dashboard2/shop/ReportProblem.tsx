/* ReportProblem — [SAATHUM-SHOP-DASH-1] "Wrong item? Report it" modal on a delivered order.
 * POST /api/shop/orders/:id/problem { message (10..1000), photo_url? }. The optional photo goes
 * to /upload/public first (same byte-staging route as uploadCover in admin2/eventsApi.ts, with
 * the customer's own token). 409 window_closed is shown calmly and the card refreshes. */
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../../lib/env';
import { fileNameHeader, UPLOAD_FALLBACK_MESSAGE } from '../../../lib/uploadHeaders';
import { capture, captureException } from '../../../lib/analytics';
import { authToken, errCode, errMessage, meApi } from '../accountApi';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

class UploadError extends Error {}

async function uploadPhoto(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new UploadError('Use a JPG, PNG or WebP photo.');
  if (file.size > MAX_BYTES) throw new UploadError('That photo is larger than 8 MB.');
  const token = await authToken();
  if (!token) throw new UploadError('Please sign in again.');
  const res = await fetch(`${API_BASE}/upload/public`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-content-type': file.type, 'x-file-name': fileNameHeader(file.name), 'x-app': 'saathum' },
    body: file,
  });
  let body: { url?: string; message?: string } = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok || !body.url) throw new UploadError(body.message ?? UPLOAD_FALLBACK_MESSAGE);
  return body.url;
}

export default function ReportProblem({ orderId, orderNo, onClose, onDone }: { orderId: string; orderNo: string; onClose: () => void; onDone: (closed: boolean) => void }) {
  const [message, setMessage] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const len = message.trim().length;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (len < 10) { setErr('Please tell us a little more (at least 10 characters).'); return; }
    if (len > 1000) { setErr('Please keep it under 1000 characters.'); return; }
    setBusy(true); setErr('');
    try {
      const photo_url = photo ? await uploadPhoto(photo) : undefined;
      await meApi(`/api/shop/orders/${encodeURIComponent(orderId)}/problem`, { method: 'POST', body: { message: message.trim(), ...(photo_url ? { photo_url } : {}) } });
      capture('dash_order_problem_reported', { order_id: orderId, has_photo: !!photo_url, ok: true });
      onDone(false);
    } catch (ex) {
      const code = errCode(ex);
      capture('dash_order_problem_reported', { order_id: orderId, has_photo: !!photo, ok: false, reason: code ?? 'network' });
      if (code !== 'window_closed' && !(ex instanceof UploadError)) captureException(ex, { where: 'dash_order_problem', order_id: orderId });
      setErr(ex instanceof UploadError ? ex.message : errMessage(ex, 'We could not send your report. Please try again.'));
      if (code === 'window_closed') onDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sh-modal is-on" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="sh-modal-box" role="dialog" aria-modal="true" aria-labelledby="sh-prob-t" onSubmit={submit}>
        <h2 id="sh-prob-t">Wrong item? Report it</h2>
        <p>Order {orderNo}. Tell us what is wrong and add a photo if you can — we will replace it or refund you.</p>
        <div className="sh-form">
          <label className="full">What went wrong?
            <textarea ref={box} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} placeholder="For example: I ordered a Black L but received a Maroon M." />
            <small>{len}/1000 · at least 10 characters</small>
          </label>
          <label className="full">Photo (optional)
            <input type="file" accept={IMAGE_TYPES.join(',')} onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            {photo && <small>{photo.name}</small>}
          </label>
        </div>
        <div className="sh-err" role="alert">{err}</div>
        <div className="sh-oact">
          <button type="submit" className="sh-btn sh-btn--red" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
