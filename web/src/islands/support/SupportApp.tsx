// [HF-SUPPORT-DESK] Root of the support desk: auth gate, staff-or-customer detection, and the routes.
// Staff are detected by calling the admin API (the worker is the only source of truth): 2xx = staff, 403 = customer.
import { useEffect, useState } from 'react';
import './support.css';
import { SupportApiError, adminApi, errMessage } from './api';
import AdminInbox from './AdminInbox';
import AdminQueues from './AdminQueues';
import AdminReports from './AdminReports';
import AdminSettings from './AdminSettings';
import AdminTicket from './AdminTicket';
import { AuthProvider, useAuthState } from './auth';
import CustomerApp from './CustomerApp';
import { navigate, useLoc } from './router';
import SignIn from './SignIn';
import { StaffProvider } from './staff';
import type { AdminList } from './types';
import { ErrorBox, Spinner, ToastProvider } from './ui';

type Probe = { state: 'checking' } | { state: 'staff'; list: AdminList } | { state: 'customer' } | { state: 'error'; message: string };

function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}

function StaffRoutes({ list }: { list: AdminList }) {
  const { path } = useLoc();
  const [, setCounts] = useState<AdminList['counts']>(list.counts);
  const t = path.match(/^\/desk\/t\/(HF-\d+)$/i);
  if (path === '/' || path === '/desk' || path === '/sign-in') return path === '/desk' ? <AdminInbox initial={list} onCounts={setCounts} /> : <Redirect to="/desk" />;
  if (t) return <AdminTicket key={t[1].toUpperCase()} number={t[1].toUpperCase()} />;
  if (path === '/desk/queues') return <AdminQueues />;
  if (path === '/desk/reports') return <AdminReports />;
  if (path === '/desk/settings') return <Redirect to="/desk/settings/signature" />;
  const s = path.match(/^\/desk\/settings\/([a-z]+)$/);
  if (s) return <AdminSettings section={s[1]} />;
  return <Redirect to="/desk" />;
}

function Shell() {
  const auth = useAuthState();
  const { path } = useLoc();
  const [probe, setProbe] = useState<Probe>({ state: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!auth.ready || !auth.signedIn) { setProbe({ state: 'checking' }); return; }
    let live = true;
    setProbe({ state: 'checking' });
    adminApi.list({ folder: 'unassigned' })
      .then((list) => { if (live) setProbe({ state: 'staff', list }); })
      .catch((e) => {
        if (!live) return;
        if (e instanceof SupportApiError && (e.status === 403 || e.status === 404)) setProbe({ state: 'customer' });
        else setProbe({ state: 'error', message: errMessage(e, 'We could not reach the support service.') });
      });
    return () => { live = false; };
  }, [auth.ready, auth.signedIn, attempt]);

  useEffect(() => { document.getElementById('hfs-boot')?.remove(); }, []);

  if (!auth.ready) return <div className="hfs hfs-center hfs-full"><Spinner label="Loading" /></div>;
  if (!auth.signedIn) return <SignIn />;
  if (probe.state === 'checking') return <div className="hfs hfs-center hfs-full"><Spinner label="Opening your support desk" /></div>;
  if (probe.state === 'error') {
    return (
      <div className="hfs hfs-center hfs-full">
        <ErrorBox message={probe.message} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    );
  }
  if (probe.state === 'staff') {
    return (
      <StaffProvider me={probe.list.me ?? {}}>
        <StaffRoutes list={probe.list} />
      </StaffProvider>
    );
  }
  if (path === '/sign-in' || path.startsWith('/desk')) return <Redirect to="/" />;
  return <CustomerApp />;
}

export default function SupportApp() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ToastProvider>
  );
}
