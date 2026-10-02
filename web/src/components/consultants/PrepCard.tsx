// [AUMFE-CONSULT-F1-1 2026-10-02] "Ready before your call" item: round Devanagari initial + title + one line.
import type { PrepItem } from './categoryContent';
import { fill } from './categoryContent';

export default function PrepCard({ item, name }: { item: PrepItem; name: string }) {
  const hasM = item.m !== undefined && item.m !== null;
  const mobileHidden = item.m === null;
  return (
    <div className={`prep${mobileHidden ? ' cp-d-flex' : ''}`}>
      <span className="ic">{item.ic}</span>
      <div>
        {hasM ? (
          <>
            <h3 className="cp-d">{item.h}</h3><h3 className="cp-m">{item.m!.h}</h3>
            <p className="cp-d">{fill(item.p, name)}</p><p className="cp-m">{fill(item.m!.p, name)}</p>
          </>
        ) : (
          <><h3>{item.h}</h3><p>{fill(item.p, name)}</p></>
        )}
      </div>
    </div>
  );
}
