// [AUMFE-GUIDE-BRAIN-1 2026-10-01] Who may chat with Pandit ji: everyone once panditChatEnabled is on; until then only
// uids in AGENT_ADMIN_UIDS (owner testing). Same rule as the voice guides (canUseVoice), kept as its own name so the
// two flags can diverge.
import { canUseVoice } from "../voice_agents/session_logic";

export function canUsePandit(enabled: boolean, uid: string, adminUidsRaw: string | undefined | null): boolean {
  return canUseVoice(enabled, uid, adminUidsRaw);
}
