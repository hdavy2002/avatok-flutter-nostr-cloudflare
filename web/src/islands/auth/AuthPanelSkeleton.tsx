/* AuthPanelSkeleton — shown by <ClerkLoading> while Clerk's clerk-js bundle is
 * still downloading/initialising from clerk.avatok.ai. Without this the panel
 * area is blank for the ~second or two the SDK takes to boot, which reads as a
 * broken/hung page. A zine-styled card with a spinner keeps the page alive and
 * matches the eventual <SignIn/> footprint so there's minimal layout shift.
 */
import { Card } from '../../components/Card';

export function AuthPanelSkeleton() {
  return (
    <Card shadow="lg" className="w-full max-w-sm">
      <div className="flex flex-col items-center gap-4 py-8">
        <span
          className="inline-block h-7 w-7 animate-spin rounded-full border-[3px] border-ink border-t-transparent"
          aria-hidden="true"
        />
        <p className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-inkSoft">
          Loading secure sign-in…
        </p>
      </div>
    </Card>
  );
}

export default AuthPanelSkeleton;
