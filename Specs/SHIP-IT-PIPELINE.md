# Ship It Pipeline

Canonical owner instruction for this repository.

## Trigger

When the owner says exactly **“ship it”**, run the production Android release
pipeline. This phrase authorizes the full workflow; do not ask whether the build
is staging or production, and do not ask APK versus AAB.

## Pipeline

1. Verify the intended release commit is on `main` and the working tree does not
   contain uncommitted changes expected in the release.
2. Check GitHub Actions for an already queued/running `android.yml` run for the
   same app revision.
3. Dispatch:

   ```bash
   gh workflow run android.yml --ref main \\
     -f environment=prod -f artifact=both -f play_track=internal
   ```

4. Approve the exact run at the production GitHub Environment gate.
5. Confirm the workflow produced the signed APK and AAB, published the AAB to
   Google Play Internal testing, and updated `latestAppBuild`.
6. Report the run URL, build number, artifact links, Play publication status, and
   pointer status.

## Safety rules

- Builds happen only in GitHub Actions.
- Production must be built from `main`; staging must be built from `staging`.
- Never publish staging to Google Play.
- Never ship uncommitted or unrelated working-tree changes.
- The Play upload is Internal testing, not production rollout to all users.
