/* [HF-HOME-DESI-1] Landing "Kitna kamaoge?" estimate — same formula and price steps as the dashboard's Become screen
 * (60% of the connected-call charge minus ₹2.00 per connected minute; creators set ₹5–₹1,000/min). Estimate only. */
import { useState } from 'react';
import { formatPaise } from '../../lib/money';

const PRICES = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 750, 1000];
/** Same as v3/Become hostPaisePerMin: 60% of the charge minus ₹2.00 per connected minute, in paise. */
const hostPaisePerMin = (rupees: number) => Math.max(0, Math.round(rupees * 100 * 0.6) - 200);
const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');

export default function EarnCalc() {
  const [pi, setPi] = useState(3);
  const [mins, setMins] = useState(300);
  const price = PRICES[pi], per = hostPaisePerMin(price), month = Math.round(per * mins * 4.3);
  return <div className="hfl3-calc">
    <label className="f">Your price per minute: ₹{fmt(price)}<input type="range" min={0} max={PRICES.length - 1} step={1} value={pi} onChange={e => setPi(Number(e.target.value))} aria-valuetext={`₹${price} per minute`} /></label>
    <label className="f" style={{ marginTop: 10 }}>Minutes of calls per week: {fmt(mins)}<input type="range" min={30} max={1200} step={30} value={mins} onChange={e => setMins(Number(e.target.value))} /></label>
    <div className="h3-break" style={{ marginTop: 12 }}>
      <div><span>Fans pay</span><b>₹{fmt(price)}/min</b></div>
      <div><span>You keep per minute</span><b>{formatPaise(per)}</b></div>
      <div className="tot"><span>About per month</span><span>{formatPaise(month)}</span></div>
    </div>
    <p className="small muted" style={{ marginTop: 8 }}>You earn 60% of each connected call, minus ₹2.00 per connected minute. Estimates only — real earnings depend on your calls.</p>
  </div>;
}
