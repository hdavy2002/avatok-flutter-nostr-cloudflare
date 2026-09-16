import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
/* Customer recovery surface: every purchased live ticket and 1:1 booking. */
import CommercialSchedule from './CommercialSchedule';

export function MyBookings() {
  const {t:uiT}=useUiTranslation("web-common");

  return (
    <CommercialSchedule
      role="customer"
      description={uiT("web-common.94a4598bd71c1a29","Everything this account has purchased or booked, with the server's current join window.")}
      emptyTitle={uiT("web-common.ca6869b0b7b7bd61","No tickets or appointments yet.")}
      emptyBody="Browse the marketplace to find a live event or book a 1:1 appointment."
    />
  );
}

export default MyBookings;
