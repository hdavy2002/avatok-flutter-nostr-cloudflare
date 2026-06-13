// VisionCard — a marketplace poster for one published vision agent.
//
// Built on the kit poster pattern (mirrors components/ListingTile) so it reads
// as an obvious sibling of the AvaVoice/marketplace cards, plus the AvaVision
// extras: capability + overlay + platform badges, the score label, and a live
// Call-Now / Agent-Busy availability chip (polled by the parent grid).
//
// Card links to the PUBLIC agent page `/vision/agent/<id>`.

import { Avatar } from '../../components/Avatar';
import { Pill } from '../../components/Pill';
import {
  fmtCoins,
  isFreeForCallers,
  type Capability,
  type OverlayStyle,
  type VisionAgent,
} from './avavisionApi';

const CAPABILITY_LABEL: Record<Capability, string> = {
  pose: 'Body',
  hand: 'Hands',
  face_landmark: 'Face',
  face_detect: 'Face',
  gesture: 'Gesture',
  object: 'Objects',
  image_class: 'Scene',
  segmentation: 'Segments',
  holistic: 'Full body',
  gemini_only: 'Sees',
};

const OVERLAY_LABEL: Partial<Record<OverlayStyle, string>> = {
  skeleton: 'Skeleton',
  hand_mesh: 'Hand mesh',
  face_mesh: 'Face mesh',
  bounding_box: 'Boxes',
  segmentation_mask: 'Mask',
};

function priceText(a: VisionAgent): string {
  if (isFreeForCallers(a)) return 'Free';
  return `${fmtCoins(a.ratePerHourCoins)}/hr`;
}

export interface VisionCardProps {
  agent: VisionAgent;
  /** Live availability from the grid's poll (overrides the seeded activeCalls). */
  busy?: boolean;
}

export function VisionCard({ agent, busy }: VisionCardProps) {
  const target = `/vision/agent/${encodeURIComponent(agent.id)}`;
  const isBusy = busy ?? (agent.activeCalls ?? 0) >= 10;
  const free = isFreeForCallers(agent);
  const overlay = agent.overlayEnabled ? OVERLAY_LABEL[agent.overlayStyle] : null;

  return (
    <a
      href={target}
      className={[
        'group block rounded-zine border-zine border-ink bg-card shadow-zine-sm overflow-hidden',
        'transition-transform duration-zine ease-out',
        'hover:-translate-x-[1px] hover:-translate-y-[1px]',
        'active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
      ].join(' ')}
    >
      {/* Poster head — avatar on a lilac field (sibling of the AvaVoice call card). */}
      <div className="relative aspect-[4/5] w-full overflow-hidden border-b-zine border-ink bg-lilac">
        <div className="flex h-full w-full items-center justify-center">
          <Avatar src={agent.avatarUrl} name={agent.name} size={120} fallbackClassName="bg-card" />
        </div>

        {/* availability chip */}
        <span className="absolute left-2 top-2">
          {isBusy ? <Pill kind="no">● Busy</Pill> : <Pill kind="ok">● Call now</Pill>}
        </span>

        {/* score label badge */}
        {agent.scoreLabel && (
          <span className="absolute right-2 top-2">
            <Pill kind="plain">{agent.scoreLabel}</Pill>
          </span>
        )}
      </div>

      <div className="p-3">
        <h3 className="font-display font-semibold text-[17px] leading-tight text-ink line-clamp-2">
          {agent.name}
        </h3>
        {agent.role && (
          <p className="mt-0.5 font-body font-bold text-[13px] text-inkSoft line-clamp-1">{agent.role}</p>
        )}

        {/* capability / overlay badges */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Pill kind="hint">{CAPABILITY_LABEL[agent.capability] ?? 'Vision'}</Pill>
          {overlay && <Pill kind="hint">{overlay}</Pill>}
          {agent.agenticSnapshotEnabled && <Pill kind="hint">Snapshot</Pill>}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-inkSoft truncate">
            {agent.creatorName ? agent.creatorName : 'AvaVision'}
          </span>
          <span
            className={[
              'font-display font-semibold text-[16px] whitespace-nowrap',
              free ? 'text-mintInk' : 'text-ink',
            ].join(' ')}
          >
            {priceText(agent)}
          </span>
        </div>
      </div>
    </a>
  );
}

export default VisionCard;
