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
# [HF-DESK-THEME-1] brand: our mark replaces Chatwoot's favicons (incl. the unread "badge" ones), plus the theme
mkdir -p "$HERE/dist/hf" && cp "$HERE"/assets/* "$HERE/dist/hf/"
for s in 16 32 96; do cp "$HERE/assets/hf-mark-$s.png" "$HERE/dist/favicon-${s}x${s}.png"; cp "$HERE/assets/hf-mark-$s.png" "$HERE/dist/favicon-badge-${s}x${s}.png"; done
cp "$HERE/assets/hf-mark-128.png" "$HERE/dist/favicon-512x512.png"
for f in "$HERE"/dist/apple-icon*.png "$HERE"/dist/apple-touch-icon*.png "$HERE"/dist/android-icon-*.png "$HERE"/dist/ms-icon-*.png; do cp "$HERE/assets/hf-mark-128.png" "$f"; done
python3 "$HERE/gen_theme.py" > "$HERE/dist/hf-theme.css"
# Chatwoot's brand blue is compiled into its CSS/JS as a literal (theme/colors.js brand: #2781F6), not a variable:
# swap it for our primary (rani) in the built files.
python3 - "$HERE/dist/assets" <<'PY'
import pathlib, re, sys
for f in pathlib.Path(sys.argv[1]).glob("*"):
    if f.suffix not in (".css", ".js"): continue
    s = f.read_text(encoding="utf-8", errors="surrogateescape")
    t = re.sub(r"#2781f6", "#d81b72", s, flags=re.I).replace("39 129 246", "216 27 114").replace("39,129,246", "216,27,114").replace("39, 129, 246", "216, 27, 114")
    if t != s: f.write_text(t, encoding="utf-8", errors="surrogateescape")
PY
python3 "$HERE/gen_config.py" "$ROOT/Specs/brand.json" > "$HERE/dist/hf-config.js"
echo "built: $(du -sh "$HERE/dist" | cut -f1) in $HERE/dist"

if [[ "${1:-}" == "--deploy" ]]; then
  "$ROOT/scripts/cf.sh" support-desk-cw pages deploy dist --project-name=hf-desk --branch=main --commit-dirty=true
fi
