// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] Fires ONE PostHog event when a shop page is viewed
// (shop_home_viewed, shop_product_viewed). Renders nothing. Mounted `client:idle`.
import { useEffect } from 'react';
import { capture } from '../../lib/analytics';

export default function ShopTelemetry({ event, props }: { event: string; props?: Record<string, string | number | boolean | null> }) {
  useEffect(() => { capture(event, props); }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
