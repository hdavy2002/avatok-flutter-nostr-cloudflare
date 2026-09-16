import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
// TalkEndedCard — the receipt screen after an agent talk session ends
// (`[AGENT-LIVE-1]`, BUILD SPEC §6). Shows why it ended, the money outcome
// (D7: full charge or full refund, never pro-rata), and a way back to the
// listing to book again.
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { inr } from '../../lib/money';
import { listingPath } from '../../lib/urls';
import type { AgentLiveEndReason, AgentLiveMoneyOutcome } from './AgentLiveSocket';

const REASON_COPY: Record<AgentLiveEndReason, string> = {
  slot_complete: 'Your session finished.',
  customer_end: 'You ended the call.',
  disconnect_timeout: "The call disconnected and didn't reconnect in time.",
  provider_error: 'Something went wrong on our end.',
  capacity: 'This agent was at capacity.',
  platform_error: 'Something went wrong on our end.',
  emergency_stop: 'This agent was paused.',
  no_show: "You didn't join before the slot ended.",
};

export interface TalkEndedCardProps {
  reason: AgentLiveEndReason;
  money: AgentLiveMoneyOutcome;
  /** Tokens (₹1 each) — the booking's total `amount`. */
  amount: number;
  listingId: string;
  agentName?: string | null;
}

function moneyLine(money: AgentLiveMoneyOutcome, amount: number): string {
  switch (money) {
    case 'full_charge':
      return `Charged ${inr(amount)}.`;
    case 'refund_pending':
    case 'refunded':
      return `Refund of ${inr(amount)} on its way.`;
    default:
      return '';
  }
}

export function TalkEndedCard({ reason, money, amount, listingId, agentName }: TalkEndedCardProps) {
  const {t:uiT}=useUiTranslation("web-agent-live");

  return (
    <Card fillClassName="bg-card" shadow="lg">
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <h1 className="font-display font-semibold text-[24px] leading-tight text-ink"><UiText id="web-agent-live.00ff74289a121c75" source="Call ended" /></h1>
        <p className="font-body font-bold text-[15px] text-inkSoft">{REASON_COPY[reason] ?? uiT("web-agent-live.d7c235b4a9afa12b","The call ended.")}</p>
        <p className="font-body font-bold text-[15px] text-ink">{moneyLine(money, amount)}</p>
        <div className="mt-2 flex w-full flex-col gap-2.5">
          <a href={listingPath({ id: listingId })} className="no-underline">
            <Button variant="lime" fullWidth label={agentName ? `Talk to ${agentName} again` : uiT("web-agent-live.29f3df617cbada30","Book again")} />
          </a>
          <a href="/dashboard" className="no-underline">
            <Button variant="ghost" fullWidth label={uiT("web-agent-live.be1b53baca18d782","My bookings")} />
          </a>
        </div>
      </div>
    </Card>
  );
}

export default TalkEndedCard;
