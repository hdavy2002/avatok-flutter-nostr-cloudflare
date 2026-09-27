import type { Env } from '../types';
import { json } from '../util';
import { readConfig } from './config';
import { effectiveUpi } from '../lib/upi_settings';

/** Public payment address only: no intent, booking, receipt or confirmation. */
export async function hdfcSmsQr(_req: Request, env: Env): Promise<Response> {
  const headers = {'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer'};
  try {
    const config = await readConfig(env);
    if (config.hdfcSmsEnabled !== true) return json({error: 'rail_paused'}, 503, headers);
    const upi = await effectiveUpi(env); // [SAATHUM-UPI-SETTINGS]
    const vpa = upi.vpa;
    const payee = upi.payee_name;
    if (!/^[A-Za-z0-9._-]{2,200}@[A-Za-z0-9.-]{2,80}$/.test(vpa) || !payee || payee.length > 100 || /[\u0000-\u001f\u007f]/.test(payee)) {
      return json({error: 'configuration_incomplete'}, 503, headers);
    }
    const params = new URLSearchParams({pa: vpa, pn: payee, am: '1.00', cu: 'INR', tn: 'AvaTOK test payment'});
    return json({amount_paise: 100, currency: 'INR', upi_url: `upi://pay?${params}`}, 200, headers);
  } catch {
    return json({error: 'temporarily_unavailable'}, 503, headers);
  }
}
