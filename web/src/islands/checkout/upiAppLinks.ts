export type UpiPlatform = 'android' | 'ios' | 'desktop';

// iOS routes: Google Pay India docs and PayU's UPI Intent S2S contract.
export const UPI_APPS = [
  { id: 'paytm', name: 'Paytm', packageName: 'net.one97.paytm', icon: '/assets/payments/paytm.svg', iosPrefix: 'paytm://upi/pay' },
  { id: 'google-pay', name: 'Google Pay', packageName: 'com.google.android.apps.nbu.paisa.user', icon: '/assets/payments/google-pay.png', iosPrefix: 'gpay://upi/pay' },
  { id: 'phonepe', name: 'PhonePe', packageName: 'com.phonepe.app', icon: '/assets/payments/phonepe.png', iosPrefix: 'phonepe://upi/pay' },
] as const;
export type UpiApp = typeof UPI_APPS[number];

export function upiPlatform(userAgent: string, touchPoints = 0): UpiPlatform {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return 'ios';
  return 'desktop';
}

export function upiAppHref(app: UpiApp, upiUrl: string, platform: UpiPlatform): string {
  // Keep the server's complete encoded payment query, including payee and amount.
  const query = new URL(upiUrl).search;
  if (platform === 'android') {
    // Chrome only launches this after a tap. An unavailable app returns to the QR;
    // never fall back to generic upi://, which can open a different payment app.
    const fallback = encodeURIComponent('https://avatok.ai/test/upi');
    return `intent://pay${query}#Intent;scheme=upi;package=${app.packageName};S.browser_fallback_url=${fallback};end`;
  }
  if (platform === 'ios' && app.iosPrefix) return `${app.iosPrefix}${query}`;
  return '#payment-qr';
}
