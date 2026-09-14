// [AGENT-LIVE-1] The full agent editor — every M11 field, persona-kind
// templates, voice picker, slot-length checkboxes, cover upload, knowledge
// panel and test call. Used by both `admin/agents/new.astro` (agentId=null)
// and `admin/agents/[id].astro` (agentId set). BUILD SPEC §6.
import { useEffect, useMemo, useState } from 'react';
import {
  adminCreateAgent, adminGetAgent, adminPatchAgent, adminPublishAgent,
  ApiError, type AgentAdminSaveBody, type PersonaKind, type VoiceId,
} from '../../lib/agentLive';
import { request } from '../../lib/apiClient';
import { API_BASE } from '../../lib/config';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { capture, captureException } from '../../lib/analytics';
import { fileNameHeader, UPLOAD_FALLBACK_MESSAGE } from '../../lib/uploadHeaders';
import { Spinner } from '../../components/Spinner';
import VoicePicker from './VoicePicker';
import KnowledgePanel from './KnowledgePanel';
import TestCallButton from './TestCallButton';
import { emptyDraft, PERSONA_KIND_OPTIONS, PERSONA_TEMPLATES, SLOT_MINUTE_OPTIONS } from './types';
import type { AgentDraft } from './types';

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
function inferImageMime(file: File): string | null {
  if (file.type) return file.type.startsWith('image/') ? file.type : null;
  const m = /\.[^.]+$/.exec(file.name.toLowerCase());
  return m ? IMAGE_EXT_MIME[m[0]] ?? null : null;
}

const inputCls = 'w-full rounded-zineField border-zine border-ink bg-paper px-3 py-2 font-body text-[14px] font-bold text-ink';
const labelCls = 'mb-1 block font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-inkSoft';

function draftToBody(d: AgentDraft): AgentAdminSaveBody {
  return {
    title: d.title,
    blurb: d.blurb,
    description: d.description,
    category: d.category,
    cover_media: d.coverMedia,
    persona_kind: d.personaKind,
    voice: d.voice,
    language: d.language,
    greeting: d.greeting,
    instructions: d.instructions,
    backend_instructions: d.backendInstructions,
    image_instructions: d.imageInstructions,
    price_per_min: d.pricePerMin,
    slot_minutes: d.slotMinutes,
    max_concurrent: d.maxConcurrent,
    image_reading: d.imageReading,
    memory_enabled: d.memoryEnabled,
    adults_only: d.adultsOnly,
  };
}

export default function AgentEditor({ agentId }: { agentId: string | null }) {
  const [minPricePerMin, setMinPricePerMin] = useState(3);
  const [loading, setLoading] = useState(Boolean(agentId));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(agentId);
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(() => emptyDraft(3));

  function patch(p: Partial<AgentDraft>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await request<{ agentMinPricePerMin?: number }>('/api/config');
        const floor = Number(cfg.agentMinPricePerMin ?? 3);
        setMinPricePerMin(floor);
        if (!agentId) setDraft((d) => ({ ...d, pricePerMin: Math.max(d.pricePerMin, floor) }));
      } catch { /* keep the built-in floor */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const d = await adminGetAgent(agentId);
        if (!alive) return;
        const l = d.listing; const a = d.agent;
        setDraft({
          title: String(l.title ?? ''),
          blurb: String(l.blurb ?? ''),
          description: String(l.description ?? ''),
          category: String(l.category ?? 'ai_companion'),
          coverMedia: (l.cover_media as { url: string; type?: string }[] | null) ?? [],
          personaKind: (a.persona_kind as PersonaKind) ?? 'companion',
          voice: (a.voice as VoiceId) ?? 'ripple',
          language: String(a.language ?? 'en'),
          greeting: String(a.greeting ?? ''),
          instructions: String(a.instructions ?? ''),
          backendInstructions: String(a.backend_instructions ?? ''),
          imageInstructions: String(a.image_instructions ?? ''),
          pricePerMin: Number(a.price_per_min ?? minPricePerMin),
          slotMinutes: Array.isArray(a.slot_minutes) ? (a.slot_minutes as number[]) : [10, 20, 30],
          maxConcurrent: Number(a.max_concurrent ?? 1),
          imageReading: a.image_reading === true,
          memoryEnabled: a.memory_enabled !== false,
          adultsOnly: a.adults_only === true,
        });
        setStatus((l.status as string) ?? 'draft');
      } catch (e) {
        setError(e instanceof ApiError ? e.error : 'Could not load this agent.');
        captureException(e, { where: 'agent_admin_load', agentId });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const toggleSlot = (m: number) => {
    patch({ slotMinutes: draft.slotMinutes.includes(m) ? draft.slotMinutes.filter((x) => x !== m) : [...draft.slotMinutes, m].sort((a, b) => a - b) });
  };

  function applyTemplate(kind: PersonaKind) {
    const t = PERSONA_TEMPLATES[kind];
    const hasContent = draft.greeting || draft.instructions || draft.backendInstructions || draft.imageInstructions;
    if (hasContent && !window.confirm('Replace the current greeting and instructions with the template for this persona kind? Your edits will be lost.')) {
      patch({ personaKind: kind });
      return;
    }
    patch({
      personaKind: kind,
      greeting: t.greeting,
      instructions: t.instructions,
      backendInstructions: t.backendInstructions,
      imageInstructions: t.imageInstructions,
    });
  }

  async function onCoverUpload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const token = await getActiveToken();
      if (!token) { setError('Please sign in again to upload a cover photo.'); return; }
      const mime = inferImageMime(file);
      if (!mime) { setError('Photos only, please.'); return; }
      if (file.size > MAX_COVER_BYTES) { setError('That photo is too large (max 8 MB).'); return; }
      const res = await fetch(`${API_BASE}/upload/public`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-content-type': mime, 'x-file-name': fileNameHeader(file.name), 'x-app': 'avatok' },
        body: file,
      });
      if (!res.ok) { setError(`Couldn't upload that photo (${res.status}).`); return; }
      const body = await res.json() as { url?: string };
      if (!body.url) { setError('Upload finished but no photo came back. Try again.'); return; }
      patch({ coverMedia: [{ url: body.url, type: 'image' }] });
    } catch (e) {
      setError(UPLOAD_FALLBACK_MESSAGE);
      captureException(e, { where: 'agent_admin_cover_upload' });
    } finally {
      setUploading(false);
    }
  }

  const canSave = draft.title.trim().length > 0 && draft.slotMinutes.length > 0 && draft.pricePerMin >= minPricePerMin;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = draftToBody(draft);
      if (savedId) {
        await adminPatchAgent(savedId, body);
      } else {
        const { listingId } = await adminCreateAgent(body);
        setSavedId(listingId);
        // Swap the URL to the edit route without a full reload so the
        // Knowledge base / Test call panels (which need a real agentId) show
        // up immediately after the first save.
        window.history.replaceState(null, '', `/admin/agents/${encodeURIComponent(listingId)}`);
      }
      capture('agent_admin_save', { outcome: 'ok' });
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not save this agent.');
      captureException(e, { where: 'agent_admin_save', agentId: savedId });
      capture('agent_admin_save', { outcome: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    if (!savedId) return;
    setPublishing(true);
    setError(null);
    try {
      const publish = status !== 'published';
      const r = await adminPublishAgent(savedId, publish);
      setStatus(r.status);
      capture('agent_admin_save', { outcome: publish ? 'published' : 'unpublished' });
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not change publish state.');
      captureException(e, { where: 'agent_admin_publish', agentId: savedId });
    } finally {
      setPublishing(false);
    }
  }

  const cover = draft.coverMedia[0]?.url ?? null;

  if (loading) {
    return <div className="flex items-center gap-3 p-8"><Spinner size={22} /> <span className="font-body font-bold text-inkSoft">Loading agent…</span></div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {error && <div className="rounded-zine border-zine border-ink bg-coral px-4 py-3 font-body text-[14px] font-bold text-paper">{error}</div>}

      <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-[24px] font-semibold text-ink">
            {savedId ? 'Edit agent' : 'New AI voice agent'}
          </h2>
          {status && (
            <span className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em] ${status === 'published' ? 'bg-lime text-ink' : 'bg-paper text-inkSoft'}`}>
              {status}
            </span>
          )}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Title</span>
            <input className={inputCls} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Category</span>
            <input className={inputCls} value={draft.category} onChange={(e) => patch({ category: e.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelCls}>One-liner</span>
            <input className={inputCls} value={draft.blurb} onChange={(e) => patch({ blurb: e.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelCls}>Description</span>
            <textarea rows={3} className={inputCls} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
          </label>
        </div>

        <div className="mt-4">
          <span className={labelCls}>Cover photo</span>
          <div className="flex items-center gap-3">
            {cover && <img src={cover} alt="" className="h-16 w-16 rounded-zineField border-zine border-ink object-cover" />}
            <label className="rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs cursor-pointer">
              {uploading ? 'Uploading…' : cover ? 'Replace' : 'Upload'}
              <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => { void onCoverUpload(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
        </div>
      </div>

      <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
        <h3 className="font-display text-[18px] font-semibold text-ink">Persona</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Persona kind</span>
            <select className={inputCls} value={draft.personaKind} onChange={(e) => applyTemplate(e.target.value as PersonaKind)}>
              {PERSONA_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span className="mt-1 block font-body text-[12px] font-bold text-inkMute">Pre-fills the fields below with a sensible starting template.</span>
          </label>
          <label className="block">
            <span className={labelCls}>Language</span>
            <input className={inputCls} value={draft.language} onChange={(e) => patch({ language: e.target.value })} />
          </label>
        </div>

        <div className="mt-4">
          <span className={labelCls}>Voice</span>
          <VoicePicker value={draft.voice} onChange={(voice) => patch({ voice })} />
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <label className="block">
            <span className={labelCls}>Greeting</span>
            <input className={inputCls} value={draft.greeting} onChange={(e) => patch({ greeting: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Instructions (voice layer — what the customer hears)</span>
            <textarea rows={5} className={inputCls} value={draft.instructions} onChange={(e) => patch({ instructions: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Backend instructions (memory / tool behaviour)</span>
            <textarea rows={3} className={inputCls} value={draft.backendInstructions} onChange={(e) => patch({ backendInstructions: e.target.value })} />
          </label>
          <label className="block">
            <span className={labelCls}>Image instructions (shown when a customer shares a photo)</span>
            <textarea rows={3} className={inputCls} value={draft.imageInstructions} onChange={(e) => patch({ imageInstructions: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
        <h3 className="font-display text-[18px] font-semibold text-ink">Booking</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Price per minute (₹, floor ₹{minPricePerMin})</span>
            <input
              type="number"
              min={minPricePerMin}
              className={inputCls}
              value={draft.pricePerMin}
              onChange={(e) => patch({ pricePerMin: Number(e.target.value) })}
            />
            {draft.pricePerMin < minPricePerMin && (
              <span className="mt-1 block font-body text-[12px] font-bold text-coral">Below the ₹{minPricePerMin}/min floor.</span>
            )}
          </label>
          <label className="block">
            <span className={labelCls}>Max concurrent sessions</span>
            <input type="number" min={1} className={inputCls} value={draft.maxConcurrent} onChange={(e) => patch({ maxConcurrent: Math.max(1, Number(e.target.value)) })} />
          </label>
        </div>

        <div className="mt-4">
          <span className={labelCls}>Slot lengths (minutes)</span>
          <div className="flex flex-wrap gap-2">
            {SLOT_MINUTE_OPTIONS.map((m) => (
              <label key={m} className={`flex cursor-pointer items-center gap-2 rounded-full border-zine border-ink px-3 py-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.06em] shadow-zine-xs ${draft.slotMinutes.includes(m) ? 'bg-lime text-ink' : 'bg-paper text-inkSoft'}`}>
                <input type="checkbox" className="sr-only" checked={draft.slotMinutes.includes(m)} onChange={() => toggleSlot(m)} />
                {m} min
              </label>
            ))}
          </div>
          {draft.slotMinutes.length === 0 && <span className="mt-1 block font-body text-[12px] font-bold text-coral">Pick at least one slot length.</span>}
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <label className="flex items-center gap-2 font-body text-[13px] font-bold text-ink">
            <input type="checkbox" checked={draft.imageReading} onChange={(e) => patch({ imageReading: e.target.checked })} />
            Image reading — customer can share a photo mid-call
          </label>
          <label className="flex items-center gap-2 font-body text-[13px] font-bold text-ink">
            <input type="checkbox" checked={draft.memoryEnabled} onChange={(e) => patch({ memoryEnabled: e.target.checked })} />
            Memory — remember returning customers across calls
          </label>
          <label className="flex items-center gap-2 font-body text-[13px] font-bold text-ink">
            <input type="checkbox" checked={draft.adultsOnly} onChange={(e) => patch({ adultsOnly: e.target.checked })} />
            Adults only
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
        <button
          type="button"
          disabled={saving || !canSave}
          onClick={() => void save()}
          className="rounded-full border-zine border-ink bg-lime px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50"
        >
          {saving ? 'Saving…' : savedId ? 'Save changes' : 'Create agent'}
        </button>
        {savedId && (
          <button
            type="button"
            disabled={publishing}
            onClick={() => void togglePublish()}
            className="rounded-full border-zine border-ink bg-paper px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-ink shadow-zine-xs disabled:opacity-50"
          >
            {publishing ? '…' : status === 'published' ? 'Unpublish' : 'Publish'}
          </button>
        )}
        {savedId && <TestCallButton agentId={savedId} disabled={saving} />}
      </div>

      {savedId && <KnowledgePanel agentId={savedId} />}
    </div>
  );
}
