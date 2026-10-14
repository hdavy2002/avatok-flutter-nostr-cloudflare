/* [HF-DASH-SHELL-2] Support screen inside the dashboard. The Help Center itself stays the public /help pages
 * (one copy, indexed); this screen gathers the ways to get help for a signed-in person. */
import { BRAND } from '../../../lib/brand';

export default function Support() {
  const items = [
    { href: '/help', title: 'Help Center', text: 'Answers about calls, your wallet, appointments and hosting.' },
    { href: '/contact', title: 'Contact us', text: `Write to the ${BRAND.name} team. We reply on email.` },
    { href: '/report', title: 'Report a problem or a person', text: 'Tell us about a call, a profile or anything that felt unsafe.' },
    { href: '/talk-safely', title: 'Talk safely', text: 'How we keep calls private and what to do if a call goes wrong.' },
  ];
  return <div className="hfd-section">
    <header className="hfd-section-head"><h1>Support</h1><p>We’re here to help. Choose what you need.</p></header>
    <div className="hfd-card-grid">
      {items.map(item => <a key={item.href} className="hfc-card hfd-link-card" href={item.href}><h2>{item.title} <span aria-hidden="true">→</span></h2><p>{item.text}</p></a>)}
    </div>
    <p className="hfd-muted">Email: <a href={`mailto:${BRAND.emails.support}`}>{BRAND.emails.support}</a></p>
  </div>;
}
