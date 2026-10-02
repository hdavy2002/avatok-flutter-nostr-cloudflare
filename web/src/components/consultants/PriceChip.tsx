// [AUMFE-CONSULT-F1-1 2026-10-02] Gold price chip. `minutes` adds the "/ 30 min" suffix (desktop band only).
import { rupees } from './format';

export default function PriceChip({ total, minutes, className = '' }: { total: number; minutes?: number; className?: string }) {
  return (
    <span className={`chip gold ${className}`.trim()}>
      {rupees(total)}
      {minutes ? <span className="cp-d">&nbsp;/ {minutes} min</span> : null}
    </span>
  );
}
