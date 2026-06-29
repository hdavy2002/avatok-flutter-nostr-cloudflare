// Optional Novu orchestration (group invites). The old website used Novu; this
// brings it back into the codebase as an OPTIONAL external layer on top of the
// in-app D1 notifications feed (which stays the source of truth for the bell).
//
// No-op unless the NOVU_API_KEY secret is set, so it ships dark and never blocks
// delivery. Set the secret + define a "group-invite" workflow in Novu to enable.
// Region: US (api.novu.co). For EU, set NOVU_API_BASE=https://eu.api.novu.co.
import type { Env } from "./types";

export async function novuGroupInvite(
  env: Env,
  toUid: string,
  props: { inviter: string; groupName: string; conv: string },
): Promise<void> {
  const key = (env as unknown as Record<string, string | undefined>).NOVU_API_KEY;
  if (!key) return; // dark until configured
  const base = (env as unknown as Record<string, string | undefined>).NOVU_API_BASE || "https://api.novu.co";
  const workflow = (env as unknown as Record<string, string | undefined>).NOVU_WORKFLOW_GROUP_INVITE || "group-invite";
  try {
    await fetch(`${base}/v1/events/trigger`, {
      method: "POST",
      headers: { "Authorization": `ApiKey ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: workflow,
        to: { subscriberId: toUid },
        payload: {
          inviter: props.inviter,
          groupName: props.groupName,
          conv: props.conv,
          deeplink: `avatok://group?conv=${props.conv}`,
        },
      }),
    });
  } catch { /* best-effort — Novu failure must never affect the in-app invite */ }
}
