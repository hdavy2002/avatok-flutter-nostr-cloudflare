import { useEffect, useState } from 'react';
import { bookingsEnabled } from '../../lib/hfBookingsApi';
import { PageShell } from '../../components/account/dashboardEmbed';

export type BookingFeatureState = 'checking' | 'enabled' | 'disabled';

export function useBookingFeature(): BookingFeatureState {
  const [state, setState] = useState<BookingFeatureState>('checking');
  useEffect(() => {
    let live = true;
    void bookingsEnabled().then(enabled => { if (live) setState(enabled ? 'enabled' : 'disabled'); });
    return () => { live = false; };
  }, []);
  return state;
}

export function BookingUnavailable() {
  return <PageShell className="hfb-page">
    <section className="hfb-card" role="status">
      <h1>Booking is unavailable</h1>
      <p>Appointments are not available right now. Please check back later.</p>
      <a className="hfb-button" href="/marketplace">Explore hosts</a>
    </section>
  </PageShell>;
}

export function BookingFeatureLoading() {
  return <PageShell className="hfb-page"><p className="hfb-card" role="status">Checking appointment availability…</p></PageShell>;
}
