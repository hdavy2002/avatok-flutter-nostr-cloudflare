// [DEMO-LISTING-1 2026-08-26] Copy the bazaar mockups into web/public/demo/ so
// the pretty listing route can serve them at /<username>/<slug>.
//
// WHY A COPY STEP INSTEAD OF COMMITTING THEM TWICE
//   design/live-streaming/ is the single source of truth and is already tracked
//   (see .gitignore [DESIGN-PREVIEW-1]). Committing a second copy under
//   web/public/ would be ~7MB of duplicated PNGs that silently drift the moment
//   someone edits one side. web/public/demo/ is gitignored and rebuilt here on
//   every `npm run build` / `npm run dev`, exactly like tokens.css.
//
// The mockups are plain static files — no build, no transform. They are copied
// byte-for-byte because support.js resolves <dc-import name="SiteHeader"> to the
// sibling path "./SiteHeader.dc.html" at RUNTIME; renaming anything here breaks
// that lookup with a 404 and a blank page.
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'design', 'live-streaming');
const DEST = join(here, '..', 'public', 'demo');

// Only what actually renders. uploads/ (26MB of raw drops), _src/ and
// design_handoff_avatok_auth/ are not referenced by any page and are not
// tracked in git, so they must never be required for a build to succeed.
const ITEMS = [
  'support.js',
  'assets',
  'avaTOK Listing Details.dc.html',
  'avaTOK Marketplace.dc.html',
  'avaTOK Auth.dc.html',
  'avaTOK Design System.dc.html',
  'SiteHeader.dc.html',
  'SiteFooter.dc.html',
  'TruckBorder.dc.html',
  'index.html',
];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

if (!(await exists(SRC))) {
  // Fail loudly rather than shipping a route that 404s at runtime: a missing
  // source folder means the checkout is incomplete, not that the demo is off.
  console.error(`[copy-design-demo] source folder missing: ${SRC}`);
  process.exit(1);
}

// Best-effort clean. `force: true` already swallows "not there", but a bind
// mount can also refuse the unlink outright (EPERM) even though writing over
// the same paths afterwards is fine — that happens in the sandboxed workspace.
// A stale file left behind is not worth failing a build over; cp overwrites
// every path we care about below.
try {
  await rm(DEST, { recursive: true, force: true });
} catch (err) {
  console.warn(`[copy-design-demo] could not clear ${DEST} (${err.code}) — overwriting in place`);
}
await mkdir(DEST, { recursive: true });

let copied = 0;
for (const item of ITEMS) {
  const from = join(SRC, item);
  if (!(await exists(from))) {
    console.error(`[copy-design-demo] missing required file: ${item}`);
    process.exit(1);
  }
  await cp(from, join(DEST, item), { recursive: true });
  copied++;
}

console.log(`[copy-design-demo] copied ${copied} items -> web/public/demo/`);
