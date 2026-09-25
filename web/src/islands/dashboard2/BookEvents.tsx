// Book events — [DASH2-EVENTS 2026-09-25]. Dashboard 2 home (/dashboard).
// Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md, GET /api/me/catalog.
//
// Search (debounced 250ms) + category rail + filters (date range, time of day,
// price, categories). Filters live in the URL (cat,q,from,to,tod,min,max) so a
// reload or a shared link restores them. from/to are IST calendar dates
// (YYYY-MM-DD) in the URL and epoch-ms IST day bounds on the wire. `cat` may hold
// several ids (comma-separated); the API filters one category, so a multi-pick is
// fetched unfiltered and narrowed here.
//
// No ClerkProvider here — DashNav owns it (see components/dash2/shared.tsx).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, CalendarDays, Check, ChevronRight, Clock, Flame, IndianRupee, LayoutGrid,
  Search, SlidersHorizontal, Sparkles, Sun, Sunrise, Sunset, Users, X,
} from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { capture } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Calendar } from '../../components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Slider } from '../../components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import {
  Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger,
} from '../../components/ui/drawer';
import {
  authedRequest, EmptyState, ErrorState, errorMessage, fmtIstDateTime, fmtRupees, istDayStart, istYmd,
  IST_OFFSET_MS, listingImage, Shimmer, ymdToIstStart, type CatalogResponse, type Listing,
} from '../../components/dash2/shared';

// ─────────────────────────── filters ───────────────────────────
type Tod = 'morning' | 'afternoon' | 'evening';
interface Filters {
  q: string;
  cats: string[];
  from?: string; // IST YYYY-MM-DD
  to?: string;
  tod?: Tod;
  min?: number; // rupees
  max?: number;
}
const EMPTY: Filters = { q: '', cats: [] };
const PRICE_CEIL = 5000;
const PRICE_STEP = 100;
const DAY_MS = 86_400_000;
const PLACEHOLDERS = ['Search Ganesh Puja…', 'Havan for exams…', 'Satyanarayan Katha…', 'Lakshmi Puja for prosperity…', 'Rudrabhishek…'];

function parseFilters(search: string): Filters {
  const u = new URLSearchParams(search);
  const num = (k: string) => { const v = u.get(k); if (v == null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined; };
  const ymd = (k: string) => { const v = u.get(k) ?? ''; return ymdToIstStart(v) != null ? v : undefined; };
  const tod = u.get('tod');
  return {
    q: (u.get('q') ?? '').slice(0, 120),
    cats: (u.get('cat') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12),
    from: ymd('from'),
    to: ymd('to'),
    tod: tod === 'morning' || tod === 'afternoon' || tod === 'evening' ? tod : undefined,
    min: num('min'),
    max: num('max'),
  };
}
function filtersToSearch(f: Filters): string {
  const u = new URLSearchParams();
  if (f.cats.length) u.set('cat', f.cats.join(','));
  if (f.q) u.set('q', f.q);
  if (f.from) u.set('from', f.from);
  if (f.to) u.set('to', f.to);
  if (f.tod) u.set('tod', f.tod);
  if (f.min != null) u.set('min', String(f.min));
  if (f.max != null) u.set('max', String(f.max));
  const s = u.toString();
  return s ? `?${s}` : '';
}
function activeFilterCount(f: Filters): number {
  return (f.from || f.to ? 1 : 0) + (f.tod ? 1 : 0) + (f.min != null || f.max != null ? 1 : 0) + (f.cats.length ? 1 : 0);
}

// Date presets, all in IST calendar days.
type DatePreset = 'today' | 'week' | 'month';
function presetRange(p: DatePreset): { from: string; to: string } {
  const today = istDayStart(Date.now());
  if (p === 'today') return { from: istYmd(today), to: istYmd(today) };
  if (p === 'week') return { from: istYmd(today), to: istYmd(today + 6 * DAY_MS) };
  const d = new Date(today + IST_OFFSET_MS);
  const lastOfMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) - IST_OFFSET_MS;
  return { from: istYmd(today), to: istYmd(lastOfMonth) };
}
function currentPreset(f: Filters): DatePreset | 'custom' | null {
  if (!f.from && !f.to) return null;
  for (const p of ['today', 'week', 'month'] as DatePreset[]) {
    const r = presetRange(p);
    if (r.from === f.from && r.to === f.to) return p;
  }
  return 'custom';
}
function fmtYmd(ymd?: string): string {
  const ms = ymd ? ymdToIstStart(ymd) : null;
  if (ms == null) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(ms));
}
function dateLabel(f: Filters): string {
  const p = currentPreset(f);
  if (p === 'today') return 'Today';
  if (p === 'week') return 'This week';
  if (p === 'month') return 'This month';
  if (p === 'custom') return f.from === f.to ? fmtYmd(f.from) : `${fmtYmd(f.from) || '…'} – ${fmtYmd(f.to) || '…'}`;
  return 'Any date';
}
const TOD_LABEL: Record<Tod, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
function priceLabel(f: Filters): string {
  if (f.min == null && f.max == null) return 'Any price';
  if (f.min == null) return `Under ₹${f.max!.toLocaleString('en-IN')}`;
  if (f.max == null) return `₹${f.min.toLocaleString('en-IN')}+`;
  return `₹${f.min.toLocaleString('en-IN')}–${f.max.toLocaleString('en-IN')}`;
}
const PRICE_CHIPS: { id: string; label: string; min?: number; max?: number }[] = [
  { id: 'lt500', label: 'Under ₹500', max: 500 },
  { id: '500to1500', label: '₹500–1,500', min: 500, max: 1500 },
  { id: 'gt1500', label: '₹1,500+', min: 1500 },
];

/** Local calendar day picked in the Calendar → IST YYYY-MM-DD (the day the person clicked). */
function dateToYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ymdToDate(ymd?: string): Date | undefined {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd) : null;
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : undefined;
}

// ─────────────────────────── filter controls ───────────────────────────
type Patch = (p: Partial<Filters>) => void;

function DateField({ f, set }: { f: Filters; set: Patch }) {
  const preset = currentPreset(f);
  const [calOpen, setCalOpen] = useState(false);
  const range: DateRange | undefined = f.from || f.to ? { from: ymdToDate(f.from), to: ymdToDate(f.to) } : undefined;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (
    <div className="flex flex-wrap gap-2">
      {(['today', 'week', 'month'] as DatePreset[]).map((p) => (
        <Chip key={p} active={preset === p} onClick={() => set(preset === p ? { from: undefined, to: undefined } : presetRange(p))}>
          {p === 'today' ? 'Today' : p === 'week' ? 'This week' : 'This month'}
        </Chip>
      ))}
      <Popover open={calOpen} onOpenChange={setCalOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={chipCls(preset === 'custom')}>
            <CalendarDays className="h-4 w-4" /> {preset === 'custom' ? dateLabel(f) : 'Pick dates'}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={range}
            defaultMonth={range?.from ?? today}
            disabled={{ before: today }}
            onSelect={(r) => {
              if (!r?.from) { set({ from: undefined, to: undefined }); return; }
              const from = dateToYmd(r.from);
              const to = dateToYmd(r.to ?? r.from);
              set({ from, to });
              if (r.to && r.to.getTime() !== r.from.getTime()) setCalOpen(false);
            }}
            numberOfMonths={1}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TodField({ f, set }: { f: Filters; set: Patch }) {
  const icons: Record<Tod, typeof Sun> = { morning: Sunrise, afternoon: Sun, evening: Sunset };
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={f.tod ?? ''}
      onValueChange={(v) => set({ tod: (v || undefined) as Tod | undefined })}
      className="gap-2"
      aria-label="Time of day"
    >
      {(Object.keys(TOD_LABEL) as Tod[]).map((t) => {
        const I = icons[t];
        return (
          <ToggleGroupItem key={t} value={t} className="rounded-full px-4" aria-label={TOD_LABEL[t]}>
            <I /> {TOD_LABEL[t]}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

function PriceField({ f, set }: { f: Filters; set: Patch }) {
  const [v, setV] = useState<[number, number]>([f.min ?? 0, f.max ?? PRICE_CEIL]);
  useEffect(() => { setV([f.min ?? 0, f.max ?? PRICE_CEIL]); }, [f.min, f.max]);
  const commit = (x: number[]) => set({ min: x[0] > 0 ? x[0] : undefined, max: x[1] < PRICE_CEIL ? x[1] : undefined });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm font-bold text-foreground">
        <span>₹{v[0].toLocaleString('en-IN')}</span>
        <span>{v[1] >= PRICE_CEIL ? `₹${PRICE_CEIL.toLocaleString('en-IN')}+` : `₹${v[1].toLocaleString('en-IN')}`}</span>
      </div>
      <Slider
        min={0}
        max={PRICE_CEIL}
        step={PRICE_STEP}
        minStepsBetweenThumbs={1}
        value={v}
        onValueChange={(x) => setV([x[0], x[1]])}
        onValueCommit={commit}
        aria-label="Price range in rupees"
      />
      <div className="flex flex-wrap gap-2">
        {PRICE_CHIPS.map((c) => {
          const on = f.min === c.min && f.max === c.max;
          return (
            <Chip key={c.id} active={on} onClick={() => set(on ? { min: undefined, max: undefined } : { min: c.min, max: c.max })}>
              {c.label}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

function CategoryField({ f, set, categories }: { f: Filters; set: Patch; categories: CatalogResponse['categories'] }) {
  if (!categories.length) return <p className="text-sm font-semibold text-muted-foreground">No categories for these filters.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((c) => {
        const on = f.cats.includes(c.id);
        return (
          <Chip key={c.id} active={on} onClick={() => set({ cats: on ? f.cats.filter((x) => x !== c.id) : [...f.cats, c.id] })}>
            {on && <Check className="h-3.5 w-3.5" />} {c.label}
            <span className={cn('ml-0.5 text-[11px] font-extrabold', on ? 'opacity-80' : 'text-muted-foreground')}>{c.count}</span>
          </Chip>
        );
      })}
    </div>
  );
}

function chipCls(active: boolean) {
  return cn(
    'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-bold tracking-[0.02em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    active ? 'border-accent bg-accent text-accent-foreground shadow-sm' : 'border-border/60 bg-card text-foreground hover:border-border hover:bg-muted',
  );
}
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={chipCls(active)}>{children}</button>;
}

function FilterSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 font-dash text-[15px] font-bold text-grand-teal">{icon}{title}</h3>
      {children}
    </section>
  );
}

/** Desktop/tablet: inline sticky bar of popover pills. Applies instantly. */
function FilterBar({ f, set, categories, onClear }: { f: Filters; set: Patch; categories: CatalogResponse['categories']; onClear: () => void }) {
  const pill = (on: boolean) => cn(
    'inline-flex h-10 items-center gap-2 rounded-full border px-4 text-[13px] font-bold tracking-[0.02em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    on ? 'border-accent bg-accent text-accent-foreground shadow-sm' : 'border-border/60 bg-card text-foreground hover:-translate-y-px hover:border-border hover:shadow-sm motion-reduce:hover:translate-y-0',
  );
  const count = activeFilterCount(f);
  return (
    <div className="sticky top-0 z-20 -mx-4 hidden border-b border-border/40 bg-background/85 px-4 py-3 backdrop-blur-md sm:-mx-8 sm:block sm:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 inline-flex items-center gap-1.5 text-[13px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground">
          <SlidersHorizontal className="h-4 w-4" /> Filters
        </span>
        <Popover>
          <PopoverTrigger asChild><button type="button" className={pill(!!(f.from || f.to))}><CalendarDays className="h-4 w-4" /> {dateLabel(f)}</button></PopoverTrigger>
          <PopoverContent align="start" className="w-[340px]"><FilterSection title="Date" icon={<CalendarDays className="h-4 w-4" />}><DateField f={f} set={set} /></FilterSection></PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild><button type="button" className={pill(!!f.tod)}><Clock className="h-4 w-4" /> {f.tod ? TOD_LABEL[f.tod] : 'Any time'}</button></PopoverTrigger>
          <PopoverContent align="start" className="w-auto"><FilterSection title="Time of day (IST)" icon={<Clock className="h-4 w-4" />}><TodField f={f} set={set} /></FilterSection></PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild><button type="button" className={pill(f.min != null || f.max != null)}><IndianRupee className="h-4 w-4" /> {priceLabel(f)}</button></PopoverTrigger>
          <PopoverContent align="start" className="w-[340px]"><FilterSection title="Price" icon={<IndianRupee className="h-4 w-4" />}><PriceField f={f} set={set} /></FilterSection></PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className={pill(f.cats.length > 0)}>
              <LayoutGrid className="h-4 w-4" /> {f.cats.length ? `${f.cats.length} ${f.cats.length === 1 ? 'category' : 'categories'}` : 'Categories'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[380px]"><FilterSection title="Categories" icon={<LayoutGrid className="h-4 w-4" />}><CategoryField f={f} set={set} categories={categories} /></FilterSection></PopoverContent>
        </Popover>
        {count > 0 && (
          <Button variant="ghost" size="sm" onClick={onClear} className="rounded-full text-primary hover:text-primary"><X /> Clear all</Button>
        )}
      </div>
    </div>
  );
}

/** Phones: one button that opens a vaul drawer with a draft; Apply commits. */
function FilterDrawer({ f, apply, categories }: { f: Filters; apply: (next: Filters) => void; categories: CatalogResponse['categories'] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filters>(f);
  useEffect(() => { if (open) setDraft(f); }, [open, f]);
  const set: Patch = (p) => setDraft((d) => ({ ...d, ...p }));
  const count = activeFilterCount(f);
  return (
    <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
      <DrawerTrigger asChild>
        <Button variant="outline" className="h-12 shrink-0 rounded-full px-4 sm:hidden" aria-label={`Filters${count ? `, ${count} active` : ''}`}>
          <SlidersHorizontal />
          {count > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-extrabold text-primary-foreground">{count}</span>}
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader className="text-left">
          <DrawerTitle className="text-grand-teal">Filters</DrawerTitle>
          <DrawerDescription>Narrow pujas by date, time, price and category.</DrawerDescription>
        </DrawerHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-2">
          <FilterSection title="Date" icon={<CalendarDays className="h-4 w-4" />}><DateField f={draft} set={set} /></FilterSection>
          <FilterSection title="Time of day (IST)" icon={<Clock className="h-4 w-4" />}><TodField f={draft} set={set} /></FilterSection>
          <FilterSection title="Price" icon={<IndianRupee className="h-4 w-4" />}><PriceField f={draft} set={set} /></FilterSection>
          <FilterSection title="Categories" icon={<LayoutGrid className="h-4 w-4" />}><CategoryField f={draft} set={set} categories={categories} /></FilterSection>
        </div>
        <DrawerFooter className="flex-row gap-3 border-t border-border/40">
          <Button variant="outline" className="flex-1" onClick={() => setDraft({ ...EMPTY, q: draft.q })}>Reset</Button>
          <DrawerClose asChild>
            <Button className="flex-[2]" onClick={() => apply(draft)}>Show results</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

// ─────────────────────────── search ───────────────────────────
function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const reduce = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (reduce || value) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % PLACEHOLDERS.length), 2600);
    return () => window.clearInterval(id);
  }, [reduce, value]);
  return (
    <div className={cn(
      'group relative flex h-14 flex-1 items-center rounded-full border bg-card shadow-[var(--dash-shadow,none)] transition-all sm:h-16',
      focused ? 'border-accent ring-4 ring-accent/15' : 'border-border/60 hover:border-border',
    )}>
      <Search className="pointer-events-none absolute left-5 h-5 w-5 text-grand-teal" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="Search pujas and havans"
        enterKeyHint="search"
        className="h-full w-full rounded-full bg-transparent pl-14 pr-12 text-[16px] font-bold text-foreground outline-none [&::-webkit-search-cancel-button]:hidden sm:text-[17px]"
      />
      {!value && (
        <div aria-hidden="true" className="pointer-events-none absolute left-14 right-12 overflow-hidden text-[16px] font-semibold text-muted-foreground sm:text-[17px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={idx}
              className="block truncate"
              initial={reduce ? false : { y: 14, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduce ? undefined : { y: -14, opacity: 0 }}
              transition={{ duration: 0.28, ease: 'easeOut' }}
            >
              {PLACEHOLDERS[idx]}
            </motion.span>
          </AnimatePresence>
        </div>
      )}
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="absolute right-3 flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

// ─────────────────────────── category rail ───────────────────────────
function CategoryRail({ categories, selected, total, onPick }: {
  categories: CatalogResponse['categories']; selected: string[]; total: number; onPick: (id: string | null) => void;
}) {
  const tile = (active: boolean) => cn(
    'relative flex min-w-[132px] shrink-0 snap-start flex-col items-start gap-2 overflow-hidden rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
    active
      ? 'border-accent bg-accent text-accent-foreground shadow-[var(--dash-shadow-lg,none)]'
      : 'border-border/50 bg-card text-foreground shadow-[var(--dash-shadow,none)] hover:-translate-y-0.5 hover:border-border hover:shadow-[var(--dash-shadow-lg,none)] motion-reduce:hover:translate-y-0',
  );
  const all = selected.length === 0;
  return (
    <div className="d2-scroll-row -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 pt-1 sm:-mx-8 sm:px-8" role="toolbar" aria-label="Categories">
      <button type="button" className={tile(all)} aria-pressed={all} onClick={() => onPick(null)}>
        <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', all ? 'bg-accent-foreground/15' : 'bg-secondary text-grand-teal')}><Sparkles className="h-[18px] w-[18px]" /></span>
        <span className="font-dash text-[15px] font-bold leading-tight">All</span>
        <span className={cn('text-[12px] font-bold', all ? 'opacity-80' : 'text-muted-foreground')}>{total} {total === 1 ? 'puja' : 'pujas'}</span>
      </button>
      {categories.map((c) => {
        const active = selected.includes(c.id);
        return (
          <button key={c.id} type="button" className={tile(active)} aria-pressed={active} onClick={() => onPick(c.id)}>
            <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', active ? 'bg-accent-foreground/15' : 'bg-primary/10 text-primary')}><Flame className="h-[18px] w-[18px]" /></span>
            <span className="line-clamp-2 max-w-[150px] font-dash text-[15px] font-bold leading-tight">{c.label}</span>
            <span className={cn('text-[12px] font-bold', active ? 'opacity-80' : 'text-muted-foreground')}>{c.count} {c.count === 1 ? 'puja' : 'pujas'}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────── cards ───────────────────────────
function ListingCard({ l, className }: { l: Listing; className?: string }) {
  const img = listingImage(l.image_url, 640);
  const lowSeats = l.seats_left != null && l.seats_left <= 5;
  return (
    <article className={cn(
      'group relative flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-[var(--dash-shadow,none)] transition-all duration-300 hover:-translate-y-1 hover:border-border hover:shadow-[var(--dash-shadow-lg,none)] motion-reduce:transition-none motion-reduce:hover:translate-y-0',
      className,
    )}>
      <div className="relative aspect-[4/3] overflow-hidden bg-muted">
        {img ? (
          <img src={img} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-secondary via-muted to-background text-grand-teal"><Flame className="h-10 w-10 opacity-60" /></div>
        )}
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-scrim/70 via-scrim/10 to-transparent" />
        <Badge variant="secondary" className="absolute left-3 top-3 max-w-[70%] truncate border border-border/40 shadow-sm">{l.category_label || l.category}</Badge>
        {l.status === 'live' && (
          <Badge className="absolute right-3 top-3 gap-1.5 tracking-[0.1em]"><span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" /> LIVE</Badge>
        )}
        <span className="absolute bottom-3 left-3 rounded-full bg-card px-3 py-1 text-[15px] font-extrabold text-grand-teal shadow-sm">{fmtRupees(l.price_paise)}</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 font-dash text-[16px] font-bold leading-[1.25] text-foreground">{l.title}</h3>
        {l.deity && <p className="text-[13px] font-bold text-primary">{l.deity}</p>}
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground"><CalendarDays className="h-3.5 w-3.5 shrink-0" /> {fmtIstDateTime(l.starts_at)}</p>
        {l.seats_left != null && (
          <p className={cn('flex items-center gap-1.5 text-[13px] font-bold', lowSeats ? 'text-primary' : 'text-muted-foreground')}>
            <Users className="h-3.5 w-3.5 shrink-0" /> {l.seats_left === 0 ? 'Fully booked' : `${l.seats_left} ${l.seats_left === 1 ? 'seat' : 'seats'} left`}
          </p>
        )}
        <div className="mt-auto pt-2">
          {l.seats_left === 0 ? (
            <Button className="w-full" variant="secondary" disabled>Fully booked</Button>
          ) : (
            <Button asChild className="w-full">
              <a href={l.book_url} aria-label={`Book ${l.title}`}>Book <ArrowRight /></a>
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border/40 bg-card', className)}>
      <Shimmer className="aspect-[4/3] rounded-none" />
      <div className="space-y-2.5 p-4">
        <Shimmer className="h-4 w-4/5" />
        <Shimmer className="h-3 w-1/2" />
        <Shimmer className="h-3 w-2/3" />
        <Shimmer className="mt-3 h-11 w-full" />
      </div>
    </div>
  );
}

// ─────────────────────────── screen ───────────────────────────
export default function BookEvents() {
  const reduce = useReducedMotion();
  const [f, setF] = useState<Filters | null>(null);
  const [qInput, setQInput] = useState('');
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lastSearch = useRef<string>('');

  // Restore from the URL on load and on back/forward.
  useEffect(() => {
    const load = () => { const p = parseFilters(location.search); setF(p); setQInput(p.q); };
    load();
    window.addEventListener('popstate', load);
    return () => window.removeEventListener('popstate', load);
  }, []);

  const commit = useCallback((next: Filters, how?: { filter: string; surface: 'bar' | 'drawer' | 'rail' }) => {
    setF(next);
    const url = `${location.pathname}${filtersToSearch(next)}`;
    if (url !== `${location.pathname}${location.search}`) history.replaceState(history.state, '', url);
    if (how) {
      capture('dash2_filter_apply', {
        filter: how.filter, surface: how.surface, cats: next.cats.join(',') || null, from: next.from ?? null, to: next.to ?? null,
        tod: next.tod ?? null, min: next.min ?? null, max: next.max ?? null, active_count: activeFilterCount(next),
      });
    }
  }, []);

  // Debounced search → filters (250ms).
  useEffect(() => {
    if (!f) return;
    const q = qInput.trim().slice(0, 120);
    if (q === f.q) return;
    const id = window.setTimeout(() => commit({ ...f, q }), 250);
    return () => window.clearTimeout(id);
  }, [qInput, f, commit]);

  // Fetch whenever the committed filters change.
  useEffect(() => {
    if (!f) return;
    const ac = new AbortController();
    setLoading(true); setError(null);
    const fromMs = f.from ? ymdToIstStart(f.from) : null;
    const toStart = f.to ? ymdToIstStart(f.to) : null;
    authedRequest<CatalogResponse>('/api/me/catalog', {
      signal: ac.signal,
      timeoutMs: 20000,
      query: {
        q: f.q || undefined,
        cat: f.cats.length === 1 ? f.cats[0] : undefined,
        from: fromMs ?? undefined,
        to: toStart != null ? toStart + DAY_MS - 1 : undefined,
        tod: f.tod,
        min: f.min,
        max: f.max,
      },
    }).then((r) => {
      if (ac.signal.aborted) return;
      const safe: CatalogResponse = { categories: r?.categories ?? [], groups: r?.groups ?? [] };
      setData(safe);
      setLoading(false);
      if (f.q && f.q !== lastSearch.current) {
        lastSearch.current = f.q;
        const results = safe.groups.reduce((n, g) => n + g.items.length, 0);
        capture('dash2_search', { q: f.q, q_len: f.q.length, results, active_filters: activeFilterCount(f) });
      }
    }).catch((e) => {
      if (ac.signal.aborted) return;
      setError(errorMessage(e));
      setLoading(false);
    });
    return () => ac.abort();
  }, [f, reloadKey]);

  const set = useCallback((surface: 'bar') => (p: Partial<Filters>) => {
    if (!f) return;
    commit({ ...f, ...p }, { filter: Object.keys(p).join(','), surface });
  }, [f, commit]);

  const categories = data?.categories ?? [];
  const total = categories.reduce((n, c) => n + c.count, 0);
  const groups = useMemo(() => {
    if (!data || !f) return [];
    if (f.cats.length > 1) return data.groups.filter((g) => f.cats.includes(g.category.id));
    return data.groups;
  }, [data, f]);
  const gridItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const hasResults = gridItems.length > 0;
  const showGrid = !!f && f.cats.length > 0;

  const clearAll = () => { if (!f) return; setQInput(''); commit({ ...EMPTY }, { filter: 'clear', surface: 'bar' }); };
  const pickCategory = (id: string | null, surface: 'rail' | 'bar' = 'rail') => {
    if (!f) return;
    commit({ ...f, cats: id ? (f.cats.length === 1 && f.cats[0] === id ? [] : [id]) : [] }, { filter: 'cat', surface });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  const fade = reduce ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' as const } };

  return (
    <div className="space-y-5 font-dashbody">
      <div className="flex items-center gap-3">
        <SearchBar value={qInput} onChange={setQInput} />
        {f && <FilterDrawer f={f} categories={categories} apply={(next) => commit({ ...next, q: f.q }, { filter: 'drawer', surface: 'drawer' })} />}
      </div>

      {data || !loading ? (
        <CategoryRail categories={categories} selected={f?.cats ?? []} total={total} onPick={(id) => pickCategory(id)} />
      ) : (
        <div className="-mx-4 flex gap-3 overflow-hidden px-4 pb-2 pt-1 sm:-mx-8 sm:px-8">
          {Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} className="h-[112px] w-[132px] shrink-0 rounded-2xl" />)}
        </div>
      )}

      {f && <FilterBar f={f} set={set('bar')} categories={categories} onClear={clearAll} />}

      <div aria-live="polite" aria-busy={loading}>
        {error ? (
          <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : loading && !data ? (
          <div className="space-y-8">
            {Array.from({ length: 2 }).map((_, r) => (
              <div key={r} className="space-y-3">
                <Shimmer className="h-6 w-48" />
                <div className="flex gap-4 overflow-hidden">
                  {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} className="w-[260px] shrink-0" />)}
                </div>
              </div>
            ))}
          </div>
        ) : !hasResults ? (
          <EmptyState
            icon={<Search className="h-6 w-6" />}
            title="No pujas match — clear filters"
            body="Try a different search, widen the dates or price, or browse every category."
            action={<Button variant="accent" onClick={clearAll}><X /> Clear filters</Button>}
          />
        ) : showGrid ? (
          <motion.div key={`grid-${f!.cats.join(',')}`} {...fade} className={cn('space-y-4 transition-opacity', loading && 'opacity-60')}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-dash text-[20px] font-bold text-grand-teal">
                {f!.cats.length === 1 ? (groups[0]?.category.label ?? categories.find((c) => c.id === f!.cats[0])?.label ?? 'Pujas') : `${f!.cats.length} categories`}
              </h2>
              <span className="text-[13px] font-bold text-muted-foreground">{gridItems.length} {gridItems.length === 1 ? 'puja' : 'pujas'}</span>
            </div>
            <div className="grid grid-cols-1 gap-5 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {gridItems.map((l) => <ListingCard key={l.id} l={l} />)}
            </div>
          </motion.div>
        ) : (
          <div className={cn('space-y-9 transition-opacity', loading && 'opacity-60')}>
            {groups.map((g, gi) => (
              <motion.section
                key={g.category.id}
                {...(reduce ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, delay: Math.min(gi, 5) * 0.05 } })}
                aria-labelledby={`grp-${g.category.id}`}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 id={`grp-${g.category.id}`} className="font-dash text-[19px] font-bold leading-tight text-grand-teal sm:text-[21px]">
                    {g.category.label}
                    <span className="ml-2 align-middle text-[13px] font-bold text-muted-foreground">{g.items.length}</span>
                  </h2>
                  <button type="button" onClick={() => pickCategory(g.category.id)} className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-extrabold tracking-[0.03em] text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    See all <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="d2-scroll-row -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-3 pt-1 sm:-mx-8 sm:px-8">
                  {g.items.map((l) => <ListingCard key={l.id} l={l} className="w-[78vw] max-w-[290px] shrink-0 snap-start sm:w-[270px]" />)}
                </div>
              </motion.section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
