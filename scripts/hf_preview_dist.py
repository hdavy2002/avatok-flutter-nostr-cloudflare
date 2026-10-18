#!/usr/bin/env python3
"""[HF-DS-7] Preview a built Astro site with the owner's art visible.

`astro dev` cannot show images that go through publicImage(): their /cdn-cgi/image/<opts>/<path> URLs only work on
Cloudflare. Build first (`cd web && npx astro build`), then run:

    python3 scripts/hf_preview_dist.py web/dist web/public      # serves http://127.0.0.1:4393/

It serves dist/, falls back to public/, and maps /cdn-cgi/image/<opts>/<path> to <path>. Read-only, local only.
"""
import http.server, os, re, sys
ROOT=os.path.abspath(sys.argv[1]); PUB=os.path.abspath(sys.argv[2])
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path=path.split('?')[0]
        m=re.match(r'^/cdn-cgi/image/[^/]+/(.*)$', path)
        if m: path='/'+m.group(1)
        for base in (ROOT, PUB):
            p=os.path.join(base, path.lstrip('/'))
            if os.path.isdir(p): p=os.path.join(p,'index.html')
            if os.path.exists(p): return p
        return os.path.join(ROOT, path.lstrip('/'))
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',4393),H).serve_forever()
