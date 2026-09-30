// [WEB-SEO-REBRAND-1 2026-09-27] IndexNow: tells Bing (which ChatGPT search and
// Copilot use), Yandex, Seznam and Naver that saathum.com pages changed, so they
// recrawl in hours instead of weeks. Run by hand AFTER a web deploy is live:
//   node scripts/indexnow-ping.mjs
// The key file public/a97b91804230a8c71e3bdf763cdfdef1.txt must stay deployed at the site root.
import { BRAND } from './brand.mjs';
const KEY = 'a97b91804230a8c71e3bdf763cdfdef1';
const HOST = BRAND.domain;
const res = await fetch('https://' + HOST + '/sitemap-pages.xml', { headers: { 'cache-control': 'no-cache' } });
if (!res.ok) throw new Error('sitemap-pages.xml ' + res.status);
const urls = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
urls.push('https://' + HOST + '/llms.txt');
const r = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: 'https://' + HOST + '/' + KEY + '.txt', urlList: urls }),
});
console.log('IndexNow:', r.status, r.statusText, '-', urls.length, 'URLs submitted');
if (r.status >= 400) process.exit(1);
