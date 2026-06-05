// AvaTalk Network — marketing site on avatok.ai. No backend, no API calls — purely
// static (Cloudflare Pages). Product infrastructure lives on avatok.ai subdomains
// (blossom., relay, api); this is the public landing page.
import { useState } from "react";

const PILLARS = [
  { ic: "🔑", h: "One login, many apps", p: "A single verified identity replaces 8+ social platforms." },
  { ic: "↗", h: "Cross-post in one tap", p: "Content made in one app is reusable in any other." },
  { ic: "✓", h: "Every account is a real human", p: "Selfie-liveness verification — no bots, no catfish." },
  { ic: "🧠", h: "Your AI brain remembers", p: "A private memory across everything you do — yours to see and delete." },
  { ic: "🪙", h: "Earn & spend with AvaCoins", p: "One wallet across the network. Creators get paid." },
  { ic: "🤖", h: "Your agent works while you don't", p: "A per-app AI agent that represents you — always with your approval." },
];

const APPS = [
  ["AvaChat", "#08C4C4"], ["AvaTok", "#4F8DFD"], ["AvaTweet", "#1DA1F2"], ["AvaBook", "#3B5998"],
  ["AvaGram", "#E1306C"], ["AvaLinked", "#0A66C2"], ["AvaTube", "#FF0000"], ["AvaLive", "#9146FF"],
  ["AvaDate", "#FF6FA5"], ["AvaMatri", "#B06AF0"], ["AvaLibrary", "#22C55E"], ["AvaOLX", "#FFA24D"],
  ["AvaBrain", "#0BB6AE"], ["AvaWallet", "#F59E0B"], ["AvaCalendar", "#EF4444"], ["AvaPayout", "#10B981"], ["AvaID", "#6366F1"],
];

const FAQS = [
  ["Is it really one account for everything?", "Yes. One verified identity (a cryptographic key linked to your account) signs you into every AvaTalk app. Your content, contacts, and AI memory follow you everywhere."],
  ["Are my messages private?", "Direct messages are end-to-end encrypted — not even our servers can read them. Your AI brain only learns from public content unless you choose to sync private notes from your device."],
  ["What are AvaCoins?", "In-app credits used to tip creators, buy digital goods, and book consultations. (Real-money top-up and bank withdrawals roll out region by region as regulatory approvals complete.)"],
  ["What does the AI agent do?", "You give each app a short persona and boundaries. Your agent can find matches and draft actions for you — but every consequential action lands in your Agent Inbox for approval, and it can never spend coins without an explicit tap."],
  ["Which platforms?", "Android first, in India (Hindi + English), with more platforms and regions to follow."],
];

function Nav() {
  return (
    <header className="nav">
      <div className="wrap">
        <a className="logo" href="#top"><span className="dot" /> AvaTalk</a>
        <nav>
          <a href="#features">Features</a>
          <a href="#apps">Apps</a>
          <a href="#faq">FAQ</a>
          <a href="#download" className="btn primary" style={{ padding: "8px 16px" }}>Get the app</a>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  const [legal, setLegal] = useState(null); // 'privacy' | 'terms' | null
  if (legal) return <Legal kind={legal} onBack={() => setLegal(null)} />;
  return (
    <div id="top">
      <Nav />
      <section className="hero">
        <div className="wrap">
          <h1>One verified identity.<br /><span className="grad">Every social format.</span></h1>
          <p className="lede">An AI brain that remembers everything, and an AI agent that acts for you — across one network of social apps. One login replaces 8+ platforms.</p>
          <div className="cta">
            <a className="btn primary" href="#download">Get the app</a>
            <a className="btn" href="#features">See what's inside</a>
          </div>
          <div className="market">Android-first · India · Hindi + English</div>
        </div>
      </section>

      <section id="features">
        <div className="wrap">
          <h2>Why AvaTalk</h2>
          <p className="sub">Six things no single app gives you today.</p>
          <div className="pillars">
            {PILLARS.map((p) => (
              <div className="card" key={p.h}>
                <div className="ic">{p.ic}</div>
                <h3>{p.h}</h3>
                <p>{p.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="apps" className="apps">
        <div className="wrap">
          <h2>17 apps, one account</h2>
          <p className="sub">Messaging, video, social, dating, marketplace, live — plus the AI and platform layer that ties it together.</p>
          <div className="appgrid">
            {APPS.map(([name, c]) => (
              <div className="app" key={name}>
                <span className="a" style={{ background: c }}>{name[3] || name[0]}</span>{name}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="download">
        <div className="wrap" style={{ textAlign: "center" }}>
          <h2>Get early access</h2>
          <p className="sub">Android beta first. Drop your email or grab the APK when it's live.</p>
          <div className="cta">
            <a className="btn primary" href="#">Download for Android</a>
            <a className="btn" href="#">Join the waitlist</a>
          </div>
        </div>
      </section>

      <section id="faq">
        <div className="wrap faq">
          <h2>FAQ</h2>
          <p className="sub">The questions people ask first.</p>
          {FAQS.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer>
        <div className="wrap">
          <div><strong>AvaTalk</strong> — one identity, every social format</div>
          <div>
            <a href="#features">Features</a>
            <a href="#apps">Apps</a>
            <a href="#" onClick={(e) => { e.preventDefault(); setLegal("privacy"); }}>Privacy</a>
            <a href="#" onClick={(e) => { e.preventDefault(); setLegal("terms"); }}>Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Legal({ kind, onBack }) {
  return (
    <div id="top">
      <Nav />
      <section className="legal wrap">
        <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ color: "var(--brand)", fontWeight: 600 }}>← Back</a>
        {kind === "privacy" ? (
          <>
            <h2>Privacy</h2>
            <p>Last updated: June 2026. This is a summary, not the final legal text.</p>
            <h3>What we store</h3>
            <p>Your account identity and profile. Direct messages are end-to-end encrypted and never readable by us. Your AI brain stores only derived facts — you can view and delete all of them, and the feature can be turned off.</p>
            <h3>Verification</h3>
            <p>Identity verification uses a selfie-liveness check. The video is stored in locked storage, is never made public, and is deleted when you delete your account.</p>
            <h3>Your data, your call</h3>
            <p>Deleting your account erases your media, history, contacts, AI memory, and profile across every store after a 30-day grace period.</p>
          </>
        ) : (
          <>
            <h2>Terms</h2>
            <p>Last updated: June 2026. This is a summary, not the final legal text.</p>
            <h3>Acceptable use</h3>
            <p>Be a real person, be respectful, and don't post illegal content. Public content is moderated; repeated violations lead to temporary then permanent suspension.</p>
            <h3>AvaCoins</h3>
            <p>AvaCoins are in-app credits, not legal tender. Real-money top-up and withdrawals are enabled region by region subject to regulatory approval.</p>
            <h3>Your agent</h3>
            <p>Your AI agent acts only within the persona and boundaries you set, surfaces consequential actions for your approval, and can never spend coins without your explicit confirmation.</p>
          </>
        )}
      </section>
      <footer><div className="wrap"><div>© 2026 AvaTalk</div></div></footer>
    </div>
  );
}
