/* Chadhava — [SAATHUM-CHADHAVA 2026-09-26] /admin/chadhava: the chadhava product
 * catalogue every event offers at checkout (marigold garland, havan samagri, …).
 * Contract: Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md ("Data" — saathum_chadhava).
 * API: worker/src/routes/saathum_chadhava.ts (GET/POST/PUT/DELETE /api/admin/v2/chadhava…).
 *
 * List + create/edit dialog, same shell conventions as the other Admin 2 screens
 * (adminApi, uploadCover from eventsApi.ts, dash2/shared building blocks). Delete is
 * a soft delete (active=0) — the confirm dialog says so.
 *
 * No Clerk provider here: AdminNav owns it; calls go through adminApi().
 */
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Gift, ImagePlus, Loader2, Pencil, Plus, Save, Trash2, Upload } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { ErrorState, EmptyState, Shimmer, listingImage } from '../../components/dash2/shared';
import { adminApi, errMessage, ApiError } from './adminApi';
import { uploadCover } from './eventsApi';

interface ChadhavaItem {
  id: string;
  title: string;
  description: string | null;
  price_rupees: number;
  image_url: string | null;
  active: boolean;
  sort: number;
  updated_at: number;
}

const LIMITS = { titleMax: 80, descriptionMax: 300, priceMax: 100_000 };

type FormState = { title: string; description: string; price_rupees: string; image_url: string };
const EMPTY_FORM: FormState = { title: '', description: '', price_rupees: '', image_url: '' };

export default function Chadhava() {
  const [items, setItems] = useState<ChadhavaItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogItem, setDialogItem] = useState<ChadhavaItem | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [toggling, setToggling] = useState<string | null>(null);
  const [deleteItem, setDeleteItem] = useState<ChadhavaItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await adminApi<{ items: ChadhavaItem[] }>('/api/admin/v2/chadhava');
      setItems(r.items);
    } catch (e) {
      captureException(e, { where: 'admin2_chadhava_load' });
      setError(errMessage(e));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  function openCreate() {
    setForm(EMPTY_FORM); setFormErrors({}); setDialogItem('new');
  }
  function openEdit(item: ChadhavaItem) {
    setForm({ title: item.title, description: item.description ?? '', price_rupees: String(item.price_rupees), image_url: item.image_url ?? '' });
    setFormErrors({}); setDialogItem(item);
  }

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((s) => ({ ...s, [k]: v }));
    setFormErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    const t = form.title.trim();
    if (t.length < 2 || t.length > LIMITS.titleMax) e.title = `Title must be 2–${LIMITS.titleMax} characters.`;
    if (form.description.trim().length > LIMITS.descriptionMax) e.description = `Keep the description under ${LIMITS.descriptionMax} characters.`;
    const p = Number(form.price_rupees);
    if (!Number.isInteger(p) || p < 1 || p > LIMITS.priceMax) e.price_rupees = `Price must be a whole number of rupees, ₹1–₹${LIMITS.priceMax.toLocaleString('en-IN')}.`;
    setFormErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onUpload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadCover(file);
      set('image_url', url);
    } catch (e) {
      const msg = e instanceof Error && !(e instanceof ApiError) ? e.message : errMessage(e);
      setFormErrors((x) => ({ ...x, image_url: msg }));
      captureException(e, { where: 'admin2_chadhava_upload' });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onSave() {
    if (!validate()) return;
    setSaving(true);
    const isNew = dialogItem === 'new';
    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      price_rupees: Number(form.price_rupees),
      image_url: form.image_url || null,
    };
    try {
      if (isNew) {
        await adminApi<{ ok: boolean; item: ChadhavaItem }>('/api/admin/v2/chadhava', { method: 'POST', body });
        toast.success('Product added');
        capture('admin2_chadhava_saved', { action: 'create', ok: true });
      } else {
        const item = dialogItem as ChadhavaItem;
        await adminApi<{ ok: boolean; item: ChadhavaItem }>(`/api/admin/v2/chadhava/${encodeURIComponent(item.id)}`, { method: 'PUT', body });
        toast.success('Saved');
        capture('admin2_chadhava_saved', { action: 'update', ok: true, id: item.id });
      }
      setDialogItem(null);
      await load();
    } catch (e) {
      const msg = errMessage(e);
      toast.error(msg);
      captureException(e, { where: 'admin2_chadhava_save' });
      capture('admin2_chadhava_saved', { action: isNew ? 'create' : 'update', ok: false });
    } finally { setSaving(false); }
  }

  async function onToggleActive(item: ChadhavaItem, active: boolean) {
    setToggling(item.id);
    try {
      await adminApi<{ ok: boolean; item: ChadhavaItem }>(`/api/admin/v2/chadhava/${encodeURIComponent(item.id)}`, { method: 'PUT', body: { active } });
      setItems((list) => list?.map((x) => (x.id === item.id ? { ...x, active } : x)) ?? list);
      capture('admin2_chadhava_saved', { action: active ? 'activate' : 'deactivate', ok: true, id: item.id });
    } catch (e) {
      toast.error(errMessage(e));
      captureException(e, { where: 'admin2_chadhava_toggle' });
    } finally { setToggling(null); }
  }

  async function onDelete() {
    if (!deleteItem) return;
    setDeleting(true);
    try {
      await adminApi<{ ok: boolean }>(`/api/admin/v2/chadhava/${encodeURIComponent(deleteItem.id)}`, { method: 'DELETE' });
      toast.success('Removed');
      capture('admin2_chadhava_saved', { action: 'delete', ok: true, id: deleteItem.id });
      setDeleteItem(null);
      await load();
    } catch (e) {
      toast.error(errMessage(e));
      captureException(e, { where: 'admin2_chadhava_delete' });
      capture('admin2_chadhava_saved', { action: 'delete', ok: false, id: deleteItem.id });
    } finally { setDeleting(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-[14px] font-semibold leading-relaxed text-muted-foreground">
          Every event offers all active products at checkout — marigold garlands, havan samagri and anything else you add here.
        </p>
        <Button onClick={openCreate}><Plus /> Add product</Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && !items ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => <Shimmer key={i} className="h-24 w-full rounded-xl" />)}
        </div>
      ) : items && items.length === 0 ? (
        <EmptyState icon={<Gift className="h-6 w-6" />} title="No chadhava products yet"
          body="Add a garland, havan samagri or anything else devotees can offer." action={<Button onClick={openCreate}><Plus /> Add product</Button>} />
      ) : (
        <ul className="flex flex-col gap-3">
          {items?.map((item) => (
            <li key={item.id} className={cn('dash-surface flex items-center gap-3 overflow-hidden rounded-xl border border-border/70 bg-card p-3 sm:gap-4 sm:p-4', !item.active && 'opacity-60')}>
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-20 sm:w-20">
                {item.image_url ? (
                  <img src={listingImage(item.image_url, 160) ?? item.image_url} alt="" loading="lazy" className="h-full w-full object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-muted-foreground"><ImagePlus className="h-5 w-5" /></span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-dash text-[16px] font-bold text-grand-teal">{item.title}</span>
                  {!item.active && <Badge variant="outline">Inactive</Badge>}
                </div>
                {item.description && <p className="line-clamp-1 text-[13px] font-semibold text-muted-foreground">{item.description}</p>}
                <span className="font-dash text-[15px] font-bold tabular-nums text-foreground">₹{item.price_rupees.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-center">
                <Switch checked={item.active} disabled={toggling === item.id} onCheckedChange={(v) => void onToggleActive(item, v)} aria-label={`${item.active ? 'Deactivate' : 'Activate'} ${item.title}`} />
                <Button variant="ghost" size="sm" onClick={() => openEdit(item)}><Pencil /> Edit</Button>
                <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => setDeleteItem(item)}><Trash2 /> Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={dialogItem !== null} onOpenChange={(o) => { if (!saving) setDialogItem(o ? dialogItem : null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogItem === 'new' ? 'Add a chadhava product' : 'Edit product'}</DialogTitle>
            <DialogDescription>Shown to every devotee at checkout, on every event.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex gap-4">
              <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-muted">
                {form.image_url ? <img src={listingImage(form.image_url, 240) ?? form.image_url} alt="Preview" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full items-center justify-center text-muted-foreground"><ImagePlus className="h-6 w-6" /></span>}
                {uploading && <span className="absolute inset-0 flex items-center justify-center bg-card/70"><Loader2 className="h-5 w-5 animate-spin text-primary" /></span>}
              </div>
              <div className="flex flex-1 flex-col justify-center gap-2">
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="chadhava-file"
                  onChange={(e) => void onUpload(e.target.files)} disabled={saving || uploading} />
                <Button type="button" variant="outline" size="sm" disabled={saving || uploading} onClick={() => fileRef.current?.click()}>
                  <Upload /> {form.image_url ? 'Replace image' : 'Upload image'}
                </Button>
                {form.image_url && <Button type="button" variant="ghost" size="sm" disabled={saving || uploading} onClick={() => set('image_url', '')}><Trash2 /> Remove image</Button>}
                {formErrors.image_url && <p className="text-[12px] font-semibold text-destructive">{formErrors.image_url}</p>}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="chadhava-title" className="font-bold">Title</Label>
              <Input id="chadhava-title" value={form.title} maxLength={LIMITS.titleMax} disabled={saving}
                onChange={(e) => set('title', e.target.value)} placeholder="Marigold garland" aria-invalid={!!formErrors.title} />
              {formErrors.title && <p className="text-[12px] font-semibold text-destructive">{formErrors.title}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="chadhava-desc" className="font-bold">Description</Label>
              <textarea id="chadhava-desc" rows={3} value={form.description} maxLength={LIMITS.descriptionMax} disabled={saving}
                onChange={(e) => set('description', e.target.value)} placeholder="A fresh marigold garland offered in your name."
                className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm" />
              {formErrors.description && <p className="text-[12px] font-semibold text-destructive">{formErrors.description}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="chadhava-price" className="font-bold">Price (₹)</Label>
              <Input id="chadhava-price" type="number" inputMode="numeric" min={1} max={LIMITS.priceMax} step={1} value={form.price_rupees} disabled={saving}
                onChange={(e) => set('price_rupees', e.target.value)} placeholder="51" aria-invalid={!!formErrors.price_rupees} />
              {formErrors.price_rupees && <p className="text-[12px] font-semibold text-destructive">{formErrors.price_rupees}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDialogItem(null)}>Cancel</Button>
            <Button disabled={saving || uploading} onClick={() => void onSave()}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteItem} onOpenChange={(o) => { if (!deleting) setDeleteItem(o ? deleteItem : null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteItem?.title}?</AlertDialogTitle>
            <AlertDialogDescription className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              It stops showing at checkout right away. Past bookings that already included it keep their own record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={(e) => { e.preventDefault(); void onDelete(); }}>
              {deleting && <Loader2 className="animate-spin" />} Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
