// [AUMFE-CONSULT-F1-1 2026-10-02] Questions people ask: dashed-rule <details> list (desktop wording + shorter mobile wording).
import { fill, type Qa } from './categoryContent';

export default function Faq({ desktop, mobile, name }: { desktop: Qa[]; mobile: Qa[]; name: string }) {
  return (
    <div>
      <div className="cp-d">{desktop.map((x, i) => <Item key={x.q} qa={x} name={name} open={i === 0} />)}</div>
      <div className="cp-m">{mobile.map((x, i) => <Item key={x.q} qa={x} name={name} open={i === 0} />)}</div>
    </div>
  );
}
function Item({ qa, name, open }: { qa: Qa; name: string; open: boolean }) {
  return <details className="qa" open={open}><summary>{fill(qa.q, name)}</summary><p>{fill(qa.a, name)}</p></details>;
}
