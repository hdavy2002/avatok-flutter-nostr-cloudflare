/* [HF-DASH-FRAANDS-1] "My Fraands": the hosts this person has saved with the heart. Remove a heart and the card goes. */
import { useEffect, useState } from 'react';
import { listFavourites, type FavouriteHost } from '../../../lib/hfFavouritesApi';
import { captureException } from '../../../lib/analytics';
import SaveHostButton from '../../../components/hosts/SaveHostButton';

const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '♥';
const PRESENCE: Record<FavouriteHost['presence'], { text: string; cls: string }> = {
  online: { text: 'Online', cls: 'hfd-fr-online' },
  busy: { text: 'On a call', cls: 'hfd-fr-busy' },
  offline: { text: 'Offline', cls: 'hfd-fr-offline' },
};

export default function Fraands() {
  const [items, setItems] = useState<FavouriteHost[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setItems(null); setError('');
    listFavourites().then(r => {
      if (!alive) return;
      if (r.ok) setItems(r.data.items);
      else { setError(r.message || 'We could not load your Fraands. Please try again.'); captureException(new Error(`favourites_list_${r.code || r.status}`), { area: 'hf_favourites', step: 'list', status: r.status }); }
    }).catch(e => { if (alive) setError('We could not load your Fraands. Please try again.'); captureException(e, { area: 'hf_favourites', step: 'list' }); });
    return () => { alive = false; };
  }, [retry]);

  return <div className="hfd-section">
    <header className="hfd-section-head"><h1>My Fraands</h1><p>The hosts you’ve saved, so they’re always one tap away.</p></header>
    {error && <section className="hfc-card" role="alert"><p>{error}</p><div className="hfd-actions"><button type="button" className="hfc-btn hfc-primary" onClick={() => setRetry(n => n + 1)}>Try again</button></div></section>}
    {!error && items === null && <p role="status">Loading your Fraands…</p>}
    {items && items.length === 0 && <section className="hfc-card hfd-empty-card">
      <h2>No saved hosts yet</h2>
      <p>Tap the heart on a host you like and they’ll show up here.</p>
      <div className="hfd-actions"><a className="hfc-btn hfc-primary" href="/marketplace">Explore hosts →</a></div>
    </section>}
    {items && items.length > 0 && <ul className="hfd-fr-grid">
      {items.map(h => {
        const p = PRESENCE[h.presence] ?? PRESENCE.offline;
        return <li key={h.slug} className="hfc-card hfd-fr-card">
          <div className="hfd-fr-top">
            {h.photoUrl ? <img className="hfd-fr-photo" src={h.photoUrl} alt="" width={64} height={64} loading="lazy" /> : <span className="hfd-avatar hfd-fr-photo" aria-hidden="true">{initials(h.displayName)}</span>}
            <div className="hfd-fr-name"><h2>{h.displayName}</h2><span className={`hfd-fr-pill ${p.cls}`}>{p.text}</span></div>
            <SaveHostButton slug={h.slug} name={h.displayName} surface="dashboard" initialSaved onChange={saved => { if (!saved) setItems(cur => cur ? cur.filter(x => x.slug !== h.slug) : cur); }} />
          </div>
          {h.headline && <p className="hfd-fr-headline">{h.headline}</p>}
          <a className="hfc-btn" href={`/h/${h.slug}`}>View profile</a>
        </li>;
      })}
    </ul>}
  </div>;
}
