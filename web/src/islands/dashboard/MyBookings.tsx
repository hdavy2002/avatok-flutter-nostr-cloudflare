/* Customer recovery surface: every purchased live ticket and 1:1 booking. */
import CommercialSchedule from './CommercialSchedule';

export function MyBookings() {
  return (
    <CommercialSchedule
      role="customer"
      description="Everything this account has purchased or booked, with the server's current join window."
      emptyTitle="No tickets or appointments yet."
      emptyBody="Browse the marketplace to find a live event or book a 1:1 appointment."
    />
  );
}

export default MyBookings;
