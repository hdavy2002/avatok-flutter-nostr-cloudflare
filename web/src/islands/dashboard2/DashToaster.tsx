// [DASH2-FOUNDATION 2026-09-25] The page's single sonner <Toaster/>. Screen
// islands call `toast(...)` from components/ui/sonner (same module singleton).
import { Toaster } from '../../components/ui/sonner';

export default function DashToaster() {
  return <Toaster />;
}
