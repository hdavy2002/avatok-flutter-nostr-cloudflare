import type { CapacitorConfig } from '@capacitor/cli';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Everything brand-related comes from Specs/brand.json (same file scripts/brand.mjs reads).
// Never type the brand name or domain here.
const brand = JSON.parse(readFileSync(resolve(__dirname, '..', 'Specs', 'brand.json'), 'utf8'));
const { domain, hosts } = brand;

const config: CapacitorConfig = {
  appId: brand.hfPlayPackageId,
  appName: brand.name,
  webDir: 'www',
  server: {
    url: `https://${domain}`,
    errorPath: 'offline.html',
    allowNavigation: [domain, hosts.api, hosts.auth, hosts.media],
    androidScheme: 'https',
  },
  android: {
    // Bump the number when the shell itself changes (the website reads it).
    appendUserAgent: 'HelloFraandsApp/1',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#fff8e8',
      androidScaleType: 'CENTER_INSIDE',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
