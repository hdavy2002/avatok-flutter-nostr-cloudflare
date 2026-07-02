# RESTORE — Nostr full rip-out (2026-07-02)

Snapshot of every file touched by the full Nostr removal + vault re-key migration.
To revert: copy these files back over the working tree, e.g.

    cd /Users/davy/Documents/websites/avaTOK-2-Flutter
    cp -R _backups/2026-07-02-nostr-full-ripout/app/* app/
    cp -R _backups/2026-07-02-nostr-full-ripout/worker/* worker/

Then rebuild (staging push) and redeploy the worker (wrangler deploy).
