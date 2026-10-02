// [AUMFE-CONSULT-F1-1 2026-10-02] Mounts the shared Clerk session bridge (no UI) only when a session cookie hints at a
// signed-in visitor — same pattern as islands/guides/HomeGuidesAd. Anonymous visitors never load Clerk.
import { useEffect, useState, type ReactNode } from 'react';
import { ClerkSessionBridge } from '../../lib/clerk';
import { hasClerkSessionHint } from '../../lib/sessionHint';

export default function WithAuth({ children }: { children: ReactNode }) {
  const [withClerk, setWithClerk] = useState(false);
  useEffect(() => { setWithClerk(hasClerkSessionHint()); }, []);
  return <>{withClerk && <ClerkSessionBridge />}{children}</>;
}
