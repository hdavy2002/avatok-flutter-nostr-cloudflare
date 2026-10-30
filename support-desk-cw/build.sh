#!/usr/bin/env bash
# [HF-DESK-CW-1] Build the agent desk: Chatwoot's MIT dashboard at a pinned commit + our patch + our config/login page.
#   support-desk-cw/build.sh            -> support-desk-cw/dist/
#   support-desk-cw/build.sh --deploy   -> also deploys dist/ to the Pages project (production; needs ALLOW_PROD=1)
# Needs node + pnpm and ~7 GB RAM for the build (the dashboard bundle is large). No Chatwoot server is involved.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REF="$(tr -d '[:space:]' < "$HERE/chatwoot.ref")"
SRC="$HERE/.chatwoot"

if [[ ! -d "$SRC/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/chatwoot/chatwoot.git "$SRC"
fi
git -C "$SRC" fetch -q --depth 1 origin "$REF"
git -C "$SRC" checkout -q -f "$REF"
git -C "$SRC" clean -fdq -e node_modules
for p in "$HERE"/patches/*.patch; do git -C "$SRC" apply "$p"; done

mkdir -p "$SRC/hfdesk"
cp "$HERE/src/index.html" "$SRC/hfdesk/index.html"
cp "$HERE/src/vite.hfdesk.config.ts" "$SRC/vite.hfdesk.config.ts"

(cd "$SRC" && npx -y pnpm@10.2.0 install --frozen-lockfile --ignore-scripts --config.node-version=24.11.0 --reporter=append-only | tail -4)
(cd "$SRC" && NODE_OPTIONS=--max-old-space-size=7000 npx vite build -c vite.hfdesk.config.ts)

rm -rf "$HERE/dist"
mv "$SRC/hfdesk-dist" "$HERE/dist"
mv "$HERE/dist/hfdesk/index.html" "$HERE/dist/index.html" && rmdir "$HERE/dist/hfdesk"
rm -rf "$HERE/dist/videos" "$HERE/dist/downloads"          # onboarding videos: 35 MB we never show
rm -f "$HERE/dist/404.html" "$HERE/dist/422.html" "$HERE/dist/500.html"   # a 404.html turns off the Pages single-page fallback
cp "$HERE/src/hf-login.html" "$HERE/src/_redirects" "$HERE/src/_headers" "$HERE/dist/"
cp "$HERE/CHATWOOT-LICENSE" "$HERE/dist/CHATWOOT-LICENSE.txt"
python3 "$HERE/gen_config.py" "$ROOT/Specs/brand.json" > "$HERE/dist/hf-config.js"
echo "built: $(du -sh "$HERE/dist" | cut -f1) in $HERE/dist"

if [[ "${1:-}" == "--deploy" ]]; then
  "$ROOT/scripts/cf.sh" support-desk-cw pages deploy dist --project-name=hf-desk --branch=main --commit-dirty=true
fi
