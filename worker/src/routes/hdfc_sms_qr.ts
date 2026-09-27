import type { Env } from '../types';
import { json } from '../util';
import { readConfig } from './config';
import { readUpiSettings, VPA_RE } from '../lib/upi_settings';

/** Public payment address only: no intent, booking, receipt or confirmation. */
export async function hdfcSmsQr(_req: Request, env: Env): Promise<Response> {
  const headers = {'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer'};
  try {
    const config = await readConfig(env);
    if (config.hdfcSmsEnabled !== true) return json({error: 'rail_paused'}, 503, headers);
    // [SAATHUM-UPI-SETTINGS] Admin-set UPI ID wins; otherwise the secrets. Unlike
    // checkout, no default payee name here — an empty one stays a 503 (tested).
    const saved = await readUpiSettings(env);
    const adminVpa = VPA_RE.test(saved.vpa?.trim() ?? '') ? saved.vpa!.trim() : '';
    const vpa = adminVpa || (env.HDFC_UPI_VPA?.trim() ?? '');
    const payee = (adminVpa && saved.payee_name?.trim()) || (env.HDFC_UPI_PAYEE_NAME?.trim() ?? '');
    if (!/^[A-Za-z0-9._-]{2,200}@[A-Za-z0-9.-]{2,80}$/.test(vpa) || !payee || payee.length > 100 || /[\u0000-\u001f\u007f]/.test(payee)) {
      return json({error: 'configuration_incomplete'}, 503, headers);
    }
    const params = new URLSearchParams({pa: vpa, pn: payee, am: '1.00', cu: 'INR', tn: 'AvaTOK test payment'});
    return json({amount_paise: 100, currency: 'INR', upi_url: `upi://pay?${params}`}, 200, headers);
  } catch {
    return json({error: 'temporarily_unavailable'}, 503, headers);
  }
}
