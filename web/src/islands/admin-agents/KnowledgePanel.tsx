// [AGENT-LIVE-1] Knowledge-base panel: drag-drop PDF/TXT/MD/DOCX upload, a
// per-file status chip (uploaded/indexing/indexed/failed), polling every 3s
// while any file is indexing, and delete. BUILD SPEC §6.
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminDeleteKb, adminListKb, adminUploadKb, ApiError, type KbFile } from '../../lib/agentLive';
import { capture, captureException } from '../../lib/analytics';
import { Spinner } from '../../components/Spinner';

const ACCEPT = '.pdf,.txt,.md,.docx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous ceiling for a knowledge doc

function statusChipCls(status: KbFile['status']): string {
  switch (status) {
    case 'indexed': return 'bg-lime text-ink';
    case 'indexing': return 'bg-terracotta text-terracottaInk';
    case 'failed': return 'bg-coral text-paper';
    default: return 'bg-paper text-ink';
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function KnowledgePanel({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<KbFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<Record<string, number>>({}); // name -> pct
  const [busyDelete, setBusyDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await adminListKb(agentId);
      setFiles(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not load the knowledge base.');
      captureException(e, { where: 'agent_kb_list', agentId });
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  // Poll every 3s while any file is still indexing (BUILD SPEC §6).
  useEffect(() => {
    const anyIndexing = files.some((f) => f.status === 'indexing');
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    if (anyIndexing) {
      pollRef.current = window.setInterval(() => { void load(); }, 3000);
    }
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [files, load]);

  async function uploadOne(file: File) {
    if (file.size > MAX_BYTES) {
      setError(`${file.name} is too large (max ${fmtBytes(MAX_BYTES)}).`);
      return;
    }
    setUploading((s) => ({ ...s, [file.name]: 0 }));
    setError(null);
    try {
      const kb = await adminUploadKb(agentId, file, (pct) => setUploading((s) => ({ ...s, [file.name]: pct })));
      setFiles((prev) => [...prev.filter((f) => f.fileId !== kb.fileId), kb]);
      capture('agent_kb_upload', { outcome: 'ok', bytes: file.size });
    } catch (e) {
      setError(e instanceof ApiError ? e.error : `Could not upload ${file.name}.`);
      captureException(e, { where: 'agent_kb_upload', agentId });
      capture('agent_kb_upload', { outcome: 'error', bytes: file.size });
    } finally {
      setUploading((s) => { const { [file.name]: _drop, ...rest } = s; return rest; });
      void load();
    }
  }

  async function onFiles(list: FileList | null) {
    if (!list || !list.length) return;
    for (const f of Array.from(list)) {
      await uploadOne(f);
    }
  }

  async function onDelete(fileId: string) {
    setBusyDelete(fileId);
    try {
      await adminDeleteKb(agentId, fileId);
      setFiles((prev) => prev.filter((f) => f.fileId !== fileId));
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not delete that file.');
      captureException(e, { where: 'agent_kb_delete', agentId, fileId });
    } finally {
      setBusyDelete(null);
    }
  }

  return (
    <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
      <h3 className="font-display text-[18px] font-semibold text-ink">Knowledge base</h3>
      <p className="mt-1 font-body text-[13px] font-bold text-inkSoft">
        PDF, TXT, MD or DOCX. Indexed files are searchable by the agent mid-conversation.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        className={`mt-3 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-zineField border-zine border-dashed px-4 py-6 text-center transition-colors ${
          dragOver ? 'border-ink bg-lime' : 'border-ink bg-paper'
        }`}
      >
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink">
          Drop files here, or click to browse
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {error && (
        <div className="mt-3 rounded-zine border-zine border-ink bg-coral px-3 py-2 font-body text-[13px] font-bold text-paper">
          {error}
        </div>
      )}

      {Object.entries(uploading).map(([name, pct]) => (
        <div key={name} className="mt-3 flex items-center gap-2 font-body text-[13px] font-bold text-inkSoft">
          <Spinner size={16} /> Uploading {name}… {pct}%
        </div>
      ))}

      <div className="mt-4 flex flex-col gap-2">
        {loading ? (
          <div className="flex items-center gap-2 font-body text-[13px] font-bold text-inkSoft"><Spinner size={16} /> Loading…</div>
        ) : files.length === 0 ? (
          <p className="font-body text-[13px] font-bold text-inkMute">No knowledge files yet.</p>
        ) : (
          files.map((f) => (
            <div key={f.fileId} className="flex flex-wrap items-center gap-2 rounded-zineField border-zine border-ink bg-paper px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-body text-[13px] font-bold text-ink">{f.name}</span>
              <span className="font-body text-[12px] font-bold text-inkMute">{fmtBytes(f.bytes)}</span>
              <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] ${statusChipCls(f.status)}`}>
                {f.status}
              </span>
              {f.status === 'failed' && f.error && (
                <span className="basis-full font-body text-[12px] font-bold text-coral">{f.error}</span>
              )}
              <button
                type="button"
                disabled={busyDelete === f.fileId}
                onClick={() => void onDelete(f.fileId)}
                className="rounded-full border-zine border-ink bg-paper px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50"
              >
                {busyDelete === f.fileId ? '…' : 'Delete'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
