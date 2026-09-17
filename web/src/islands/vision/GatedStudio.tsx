import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
/* GatedStudio — the AvaVision studio behind the account gate.
 * Creating a vision agent is a creator action, so the WHOLE studio (not just the
 * final publish) requires a session, matching the app. RequireAccount renders the
 * sign-in prompt for anonymous visitors and the StudioFlow once authed.
 */
import { RequireAccount } from '../auth/RequireAccount';
import StudioFlow from './StudioFlow';

export function GatedStudio() {
  const {t:uiT}=useUiTranslation("web-common");

  return (
    <RequireAccount label={uiT("web-common.37e4d1f083ab8aee","Creating a vision agent")}>
      <StudioFlow />
    </RequireAccount>
  );
}

export default GatedStudio;
