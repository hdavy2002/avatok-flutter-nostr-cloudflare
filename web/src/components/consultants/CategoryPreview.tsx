// [AUMFE-CONSULT-F1-1 2026-10-02] The dark "preview" panel of the "Ready before your call" section — per category:
// sample kundli (SVG), Lo Shu grid, palm map, face map. Pure illustration (samples), copied from the mockup.
// The tarot spread is rendered by TarotSpread below (it spans the full width on desktop).
import type { CatKey } from './categoryContent';


function Kundli() {
  return (
    <svg className="cp-kundli" viewBox="0 0 300 300" role="img" aria-label="North Indian kundli, sample" style={{ fontFamily: "'Baloo 2', sans-serif" }}>
      <rect x="4" y="4" width="292" height="292" fill="none" stroke="#f2c14e" strokeWidth="2.5" />
      <path d="M4 4 296 296M296 4 4 296M150 4 296 150 150 296 4 150Z" fill="none" stroke="#f2c14e" strokeWidth="1.8" />
      <text x="150" y="82" textAnchor="middle" fontSize="17" fontWeight="800" fill="#ffb27a">५ लग्न</text><text x="150" y="104" textAnchor="middle" fontSize="16" fill="#fff8e8">सू बु</text>
      <text x="76" y="46" textAnchor="middle" fontSize="15" fill="#c9cfe8">६</text><text x="76" y="66" textAnchor="middle" fontSize="16" fill="#fff8e8">शु</text>
      <text x="76" y="154" textAnchor="middle" fontSize="15" fill="#c9cfe8">८</text><text x="76" y="174" textAnchor="middle" fontSize="16" fill="#fff8e8">रा</text>
      <text x="76" y="246" textAnchor="middle" fontSize="16" fill="#fff8e8">श</text><text x="76" y="266" textAnchor="middle" fontSize="15" fill="#c9cfe8">१०</text>
      <text x="150" y="214" textAnchor="middle" fontSize="15" fill="#c9cfe8">११</text><text x="150" y="236" textAnchor="middle" fontSize="16" fill="#fff8e8">गु</text>
      <text x="224" y="154" textAnchor="middle" fontSize="15" fill="#c9cfe8">२</text><text x="224" y="174" textAnchor="middle" fontSize="16" fill="#fff8e8">के</text>
      <text x="224" y="46" textAnchor="middle" fontSize="15" fill="#c9cfe8">४</text><text x="224" y="66" textAnchor="middle" fontSize="16" fill="#fff8e8">चं मं</text>
    </svg>
  );
}

const LOSHU: (string | null)[] = ['४', '९९', '२', '३', '५', '७', '८', '१', '६'];
const LOSHU_MISSING = new Set(['४', '२', '५', '६']);

export default function CategoryPreview({ kind }: { kind: Exclude<CatKey, 'tarot'> }) {
  if (kind === 'astro') {
    return (
      <div className="preview cp-preview">
        <span className="deva cp-ptitle"><span className="cp-d">जन्म कुंडली · Lagna chart (D1)</span><span className="cp-m">जन्म कुंडली · D1</span></span>
        <Kundli />
        <div className="cp-d cp-stats3">
          <div><span>LAGNA</span><b>Simha</b></div><div><span>RASHI</span><b>Karka</b></div><div><span>NAKSHATRA</span><b>Pushya</b></div>
        </div>
        <span className="cp-pcap cp-d">Sample chart for illustration</span>
        <span className="cp-pcap cp-m">Sample chart · Simha lagna, Karka rashi</span>
      </div>
    );
  }
  if (kind === 'numero') {
    return (
      <div className="preview cp-preview">
        <span className="deva cp-ptitle"><span className="cp-d">लो शू ग्रिड · your Lo Shu grid</span><span className="cp-m">लो शू ग्रिड</span></span>
        <div className="cp-loshu" role="img" aria-label="Sample Lo Shu grid">
          {LOSHU.map((n) => LOSHU_MISSING.has(n!)
            ? <span key={n} className="cp-miss">{n} <span className="cp-d">missing</span><span className="cp-m">—</span></span>
            : <span key={n} className="deva cp-num">{n}</span>)}
        </div>
        <div className="cp-stats3 cp-stats-big">
          <div><span>MOOLANK</span><b className="deva">९</b></div><div><span>BHAGYANK</span><b className="deva">१</b></div><div><span>NAAMANK</span><b className="deva">५</b></div>
        </div>
        <span className="cp-pcap cp-d">Sample for a birth date of 9 March 1987</span>
        <span className="cp-pcap cp-m">Sample · born 9 March 1987 · — = missing</span>
      </div>
    );
  }
  if (kind === 'palm') {
    return (
      <div className="preview cp-preview">
        <span className="deva cp-ptitle"><span className="cp-d">हस्त रेखा मानचित्र · palm map</span><span className="cp-m">हस्त रेखा मानचित्र</span></span>
        <span className="wm palm cp-palmmap" role="img" aria-label="Sample palm map" />
        <div className="cp-legend">
          <span style={{ color: '#ff8a7a' }}>● Hriday<span className="cp-d"> — heart line</span><span className="cp-m"> · heart</span></span>
          <span style={{ color: '#9fd0ff' }}>● Mastishk<span className="cp-d"> — head line</span><span className="cp-m"> · head</span></span>
          <span style={{ color: '#ffffff' }}>● Jeevan<span className="cp-d"> — life line</span><span className="cp-m"> · life</span></span>
          <span style={{ color: '#ffd36b' }}>● Bhagya<span className="cp-d"> — fate line</span><span className="cp-m"> · fate</span></span>
        </div>
        <span className="cp-pcap cp-d">Drawing for illustration — yours is drawn on your own photo</span>
      </div>
    );
  }
  return (
    <div className="preview cp-preview">
      <span className="deva cp-ptitle"><span className="cp-d">मुख मानचित्र · face map</span><span className="cp-m">मुख मानचित्र</span></span>
      <span className="wm face cp-facemap" role="img" aria-label="Sample face map" />
      <div className="cp-zones">
        <span><span className="deva">ललाट</span><br />Forehead</span>
        <span><span className="deva">मध्य</span><br />Eyes<span className="cp-d"> and nose</span><span className="cp-m">, nose</span></span>
        <span><span className="deva">चिबुक</span><br />Mouth<span className="cp-d"> and chin</span><span className="cp-m">, chin</span></span>
      </div>
      <span className="cp-pcap cp-d">Drawing for illustration — yours is drawn on your own photo</span>
    </div>
  );
}

/** Sample three-card spread (+ yes/no card on desktop). Card art is the placeholder motif from the mockup. */
export function TarotSpread() {
  return (
    <div className="preview cp-preview cp-tarot-preview">
      <div className="cp-spread">
        <div className="icard"><span className="pos"><span className="cp-d">प्रेम · Love</span><span className="cp-m">प्रेम</span></span><span className="art" /><span className="nm"><span className="cp-d">VI · The Lovers</span><span className="cp-m">The Lovers</span></span></div>
        <div className="icard"><span className="pos"><span className="cp-d">कार्य · Work</span><span className="cp-m">कार्य</span></span><span className="art" /><span className="nm"><span className="cp-d">Eight of Pentacles</span><span className="cp-m">8 Pentacles</span></span></div>
        <div className="icard rev"><span className="pos"><span className="cp-d">धन · Money</span><span className="cp-m">धन</span></span><span className="art" /><span className="nm"><span className="cp-d">Ten of Cups · reversed</span><span className="cp-m">10 Cups ↺</span></span></div>
        <span className="cp-d cp-spacer" />
        <div className="icard cp-d-flex"><span className="pos">हाँ / ना · Yes or no</span><span className="art" /><span className="nm">XIX · The Sun</span></div>
      </div>
      <span className="cp-pcap cp-d">Sample spread · card art shown is a placeholder for the Indian-art deck</span>
      <span className="cp-pcap cp-m">Sample spread · love, work, money</span>
    </div>
  );
}
