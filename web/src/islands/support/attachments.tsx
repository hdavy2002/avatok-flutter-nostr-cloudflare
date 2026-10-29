// [HF-SUPPORT-DESK] Attach files to a message: validation (images/PDFs, 10 MB each, 25 MB per message), upload through
// POST /api/hf/support/attachments with a percent-encoded x-file-name, and the chips that show what is attached.
import { useCallback, useRef, useState } from 'react';
import { errMessage, openAttachment, uploadAttachment, validateFiles } from './api';
import { fileSize } from './format';
import { Icon, useToast } from './ui';
import type { Attachment } from './types';

export interface Picked { id: string; name: string; size: number }

export function useAttachments() {
  const [items, setItems] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<Picked[]>([]);
  itemsRef.current = items;

  const add = useCallback(async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const bad = validateFiles(files, itemsRef.current);
    if (bad) { setError(bad); return; }
    setError(null);
    for (const f of files) {
      setBusy((n) => n + 1);
      try {
        const up = await uploadAttachment(f);
        setItems((l) => [...l, { id: up.id, name: up.name, size: up.size }]);
      } catch (e) {
        setError(`${f.name}: ${errMessage(e, 'could not be uploaded. Please try again.')}`);
      } finally { setBusy((n) => n - 1); }
    }
  }, []);
  const remove = useCallback((id: string) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const clear = useCallback(() => { setItems([]); setError(null); }, []);
  return { items, add, remove, clear, uploading: busy > 0, error, ids: items.map((i) => i.id) };
}

/** Hidden file input + the visible button. */
export function AttachButton({ onPick, disabled, label = 'Attach file', icon = 'paperclip', className = 'hfs-btn hfs-btn--lilac' }: {
  onPick: (files: FileList | null) => void; disabled?: boolean; label?: string; icon?: 'paperclip' | 'image'; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" hidden multiple accept="image/*,application/pdf" onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
      <button type="button" className={className} disabled={disabled} onClick={() => ref.current?.click()}><Icon name={icon} size={18} />{label}</button>
    </>
  );
}

export function PickedChips({ items, onRemove, uploading, error }: { items: Picked[]; onRemove: (id: string) => void; uploading: boolean; error: string | null }) {
  if (!items.length && !uploading && !error) return null;
  return (
    <div className="hfs-picked">
      {items.map((a) => (
        <span key={a.id} className="hfs-file">
          {a.name} · {fileSize(a.size)}
          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}>×</button>
        </span>
      ))}
      {uploading && <span className="hfs-file hfs-file--busy">Uploading…</span>}
      {error && <p className="hfs-formerr" role="alert">{error}</p>}
    </div>
  );
}

/** Attachments already on a message: click to open (the file endpoint needs the session, so it opens via a blob). */
export function FileChips({ files }: { files: Attachment[] }) {
  const toast = useToast();
  if (!files.length) return null;
  return (
    <div className="hfs-picked">
      {files.map((a) => (
        <button key={a.id} type="button" className="hfs-file hfs-file--link" onClick={() => { openAttachment(a).catch((e) => toast(errMessage(e, 'Could not open that file.'), 'error')); }}>
          {a.name}{a.size ? ` · ${fileSize(a.size)}` : ''}
        </button>
      ))}
    </div>
  );
}
