// [HF-SUPPORT-DESK] Things every staff screen shares: who I am, who else is on the team, keyboard shortcuts, the desk header.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BRAND } from '../../lib/brand';
import { adminApi } from './api';
import { useAuthState } from './auth';
import { Link, navigate } from './router';
import type { StaffMember, StaffRole } from './types';
import { Avatar, Gold, Icon, Menu, MenuItem } from './ui';

export interface StaffCtxValue { uid: string; name: string; role: StaffRole; canWrite: boolean; team: StaffMember[]; teamLoaded: boolean; loadTeam: () => void }
const Ctx = createContext<StaffCtxValue | null>(null);
export const useStaff = (): StaffCtxValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStaff outside StaffProvider');
  return v;
};

export function StaffProvider({ me, children }: { me: { uid?: string; name?: string; role?: StaffRole }; children: ReactNode }) {
  const auth = useAuthState();
  const [team, setTeam] = useState<StaffMember[]>([]);
  const [teamLoaded, setLoaded] = useState(false);
  const started = useRef(false);
  const loadTeam = () => {
    if (started.current) return;
    started.current = true;
    adminApi.staff().then((t) => { setTeam(t); setLoaded(true); }).catch(() => setLoaded(true));
  };
  useEffect(() => { loadTeam(); }, []);
  const role: StaffRole = me.role ?? team.find((t) => t.email.toLowerCase() === auth.email.toLowerCase())?.role ?? 'agent';
  const value: StaffCtxValue = {
    uid: me.uid ?? team.find((t) => t.email.toLowerCase() === auth.email.toLowerCase())?.uid ?? '', name: me.name || auth.name || 'Me', role,
    canWrite: role !== 'viewer', team, teamLoaded, loadTeam,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ── keyboard shortcuts ────────────────────────────────────────────────── */
function typing(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable || t.getAttribute('role') === 'textbox';
}

/**
 * Single-key shortcuts for the desk. Never fires while someone is typing in a field, with Ctrl/Cmd/Alt held,
 * or while a dialog is open, so it cannot break typing. `map` keys are the exact `event.key` ("j", "!", "/", "Enter").
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (typing(e.target)) return;
      if (document.querySelector('.hfs-modal')) return;
      const fn = ref.current[e.key];
      if (fn) { fn(e); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous ticket'],
  ['Enter or o', 'Open the highlighted ticket'],
  ['x', 'Select the highlighted ticket'],
  ['r', 'Reply (opens the reply box)'],
  ['n', 'Internal note'],
  ['e', 'Solve'],
  ['!', 'Flag as spam'],
  ['/', 'Search'],
  ['?', 'Show this list'],
  ['Esc', 'Leave a box and get shortcuts back'],
];

/* ── the desk header ───────────────────────────────────────────────────── */
export function DeskHeader({ search, onSearch, searchRef, queuesHealthy }: { search?: string; onSearch?: (q: string) => void; searchRef?: RefObject<HTMLInputElement | null>; queuesHealthy?: boolean | null }) {
  const auth = useAuthState();
  const me = useStaff();
  const [q, setQ] = useState(search ?? '');
  useEffect(() => setQ(search ?? ''), [search]);
  return (
    <header className="hfs-dh">
      <Link to="/desk" className="hfs-dh__brand"><Gold size={28} />Support desk</Link>
      {onSearch && (
        <>
          <label htmlFor="hfs-dq" className="hfs-sr">Search tickets</label>
          <form className="hfs-dh__search" onSubmit={(e) => { e.preventDefault(); onSearch(q.trim()); }}>
            <Icon name="search" size={18} />
            <input id="hfs-dq" ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, email, phone, handle or words" />
          </form>
        </>
      )}
      <div className="hfs-dh__right">
        <span className={`hfs-rolechip hfs-rolechip--${me.role}`}>{me.role === 'admin' ? 'Admin' : me.role === 'agent' ? 'Agent' : 'View only'}</span>
        <Menu align="right" className="hfs-dh__avatar" label={<Avatar name={me.name} tone="plum" size={38} />} title="Account">
          {(close) => (
            <>
              <div className="hfs-menu__note">{me.name}<br />{auth.email}</div>
              {queuesHealthy === false && <MenuItem onClick={() => { close(); navigate('/desk/queues'); }}>Queues need a look</MenuItem>}
              <MenuItem onClick={() => { close(); void auth.signOut(); }}>Sign out</MenuItem>
              <MenuItem onClick={() => { close(); window.location.href = `https://${BRAND.domain}/`; }}>Back to {BRAND.domain}</MenuItem>
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}

/** A sub-page header: back link + title (Queues, Settings, Reports, and a ticket). */
export function SubHeader({ back, backTo, title, children }: { back: string; backTo: string; title?: string; children?: ReactNode }) {
  return (
    <header className="hfs-dh hfs-dh--sub">
      <Link to={backTo} className="hfs-dh__back"><Icon name="back" size={20} />{back}</Link>
      {title && <h1 className="hfs-dh__title">{title}</h1>}
      <div className="hfs-dh__right">{children}</div>
    </header>
  );
}
