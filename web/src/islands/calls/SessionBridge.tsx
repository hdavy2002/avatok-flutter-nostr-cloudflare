/* [HF-CALLS-1] Mounts the Clerk token bridge only when a signed-in action needs it (keeps Explore light). */
import { Suspense, lazy } from 'react';

const Bridge = lazy(() => import('../../lib/clerk').then(m => ({ default: m.ClerkSessionBridge })));
export default function SessionBridge({ on }: { on: boolean }) {
  return on ? <Suspense fallback={null}><Bridge /></Suspense> : null;
}
