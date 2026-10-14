import { useEffect, useState } from 'react';
import { bookingsEnabled } from '../../lib/hfBookingsApi';

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
  return <main className="hfb-page">
    <section className="hfb-card" role="status">
      <h1>Booking is unavailable</h1>
      <p>Appointments are not available right now. Please check back later.</p>
      <a className="hfb-button" href="/marketplace">Explore hosts</a>
    </section>
  </main>;
}

export function BookingFeatureLoading() {
  return <main className="hfb-page"><p className="hfb-card" role="status">Checking appointment availability…</p></main>;
}
