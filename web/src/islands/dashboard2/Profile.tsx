// [DASH2-FOUNDATION 2026-09-25] PLACEHOLDER — replaced by the Profile screen owner.
// Rendered by src/pages/dashboard/profile.astro inside layouts/Dashboard2.astro.
// KEEP the phone-only Logout: on <640px the tab bar has no Logout, it lives here.
import { LogOut } from 'lucide-react';
import { Placeholder } from './Placeholder';
import { Button } from '../../components/ui/button';
import { DASH_LOGOUT } from './nav';

export default function Profile() {
  return (
    <div className="space-y-6">
      <Placeholder title="Profile" body="Your name, gotra, family, phone, UPI IDs and address." />
      <Button asChild variant="outline" className="w-full text-primary sm:hidden">
        <a href={DASH_LOGOUT.href}><LogOut /> {DASH_LOGOUT.label}</a>
      </Button>
    </div>
  );
}
