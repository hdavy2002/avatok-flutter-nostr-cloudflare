/* AvaAdmin — gate wrapper (PHASE 6). Owned by this phase (islands/admin/**).
 * Renders the admin UI only after the Worker confirms admin (fail closed). */
import type { ReactNode } from 'react';
import { useAdminGate } from './adminApi';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { Button } from '../../components/Button';

export function AdminGate({ children }: { children: ReactNode }) {
  const { state, error, retry } = useAdminGate();

  if (state === 'checking') {
    return (
      <div className="flex items-center gap-3 p-8">
        <Spinner size={22} />
        <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-inkSoft">Verifying admin access…</span>
      </div>
    );
  }
  if (state === 'admin') return <>{children}</>;

  // anon / forbidden → "Admins only" (the Worker is the real boundary).
  return (
    <Card shadow="lg">
      <div className="flex flex-col gap-3 p-2">
        <h2 className="font-display font-semibold text-[22px] text-ink">
          {state === 'anon' ? 'Sign in required' : 'Admins only'}
        </h2>
        <p className="font-body font-bold text-[15px] text-inkSoft">
          {state === 'anon'
            ? 'This console is for platform administrators. Sign in with an admin account.'
            : error || 'Your account does not have admin access to this console.'}
        </p>
        <div className="flex gap-2">
          <Button variant="blue" onClick={retry}>Retry</Button>
          <a href="/"><Button variant="ghost">Home</Button></a>
        </div>
      </div>
    </Card>
  );
}

export default AdminGate;
