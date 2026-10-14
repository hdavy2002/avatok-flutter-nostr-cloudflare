/* [HF-DASH-SHELL-2] Host profile screen: where the host's profile stands and the next step. The step-by-step
 * profile wizard (/hosts/onboarding) and video KYC (/hosts/kyc) stay full-screen flows; they return here when done. */
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { STATUS_NOTE } from '../hostActivity';

export default function HostProfile({ account }: { account: DashboardAccount }) {
  const status = account.host?.status ?? null;
  const live = status === 'live';
  return <div className="hfd-section">
    <header className="hfd-section-head"><h1>Host profile</h1><p>Your public host profile, identity check and call rates.</p></header>
    {account.closing && <aside className="hfd-notice" role="status"><strong>Your account is being closed.</strong> Hosting is paused. <a href="/dashboard/close">Manage account closure</a></aside>}
    <div className="hfd-card-grid">
      <section className="hfc-card"><h2>Profile status</h2>
        <p className="hfd-status-line">{!status ? 'You don’t have a host profile yet.' : live ? 'Your host profile is live. Callers can find you on Explore.' : (STATUS_NOTE[status] ?? 'Your profile is not live yet.')}</p>
        <div className="hfd-actions">
          {!account.closing && <a className="hfc-btn hfc-primary" href="/hosts/onboarding">{!status ? 'Become a host' : live ? 'Edit my profile' : 'Continue my profile'}</a>}
          {live && account.host?.slug && <a className="hfc-btn" href={`/h/${encodeURIComponent(account.host.slug)}`}>View my public profile</a>}
        </div>
      </section>
      {status && <section className="hfc-card"><h2>Identity check</h2><p>Hosts verify their identity with a short video check before payouts.</p><div className="hfd-actions"><a className="hfc-btn" href="/hosts/kyc">Open identity check</a></div></section>}
      <section className="hfc-card"><h2>Rates and rules</h2><p>See what callers pay, what you earn, and the rules every host follows.</p><div className="hfd-actions"><a className="hfc-btn" href="/hosts/rates">Rates</a><a className="hfc-btn" href="/hosts/rules">Host rules</a></div></section>
    </div>
  </div>;
}
