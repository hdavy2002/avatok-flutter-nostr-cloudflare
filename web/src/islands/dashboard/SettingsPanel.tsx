/* SettingsPanel — account + identity level (app: Settings/Identity).
 * GET /api/identity/level → current progressive-identity level. We surface the
 * level and the upgrade path; deep identity/KYC steps still complete in the app.
 */
import { useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';

interface IdentityLevel {
  level?: number;
  handle?: string | null;
  email?: string | null;
  email_verified?: boolean;
  kyc?: string | null;
}

const LEVELS: Record<number, string> = {
  0: 'Guest — email only',
  1: 'Member — handle claimed',
  2: 'Verified — identity confirmed',
  3: 'Creator — KYC complete',
};

function Inner() {
  const [info, setInfo] = useState<IdentityLevel | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await getActiveToken();
      if (!token) {
        setChecked(true);
        return;
      }
      try {
        setInfo(await request<IdentityLevel>('/api/identity/level', { auth: token }));
      } catch {
        setInfo({});
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  if (!checked) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /></div>;

  const level = info?.level ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <Card shadow="sm">
        <div className="flex flex-col gap-3">
          <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-blueInk">Your account</span>
          <div className="flex items-center justify-between">
            <span className="font-body font-extrabold text-[15px] text-ink">Identity level</span>
            <span className="rounded-zineBadge border-zine border-ink bg-lilac px-3 py-1 font-mono font-bold text-[12px] text-ink shadow-zine-xs">L{level}</span>
          </div>
          <p className="font-body font-bold text-[14px] text-inkSoft">{LEVELS[level] ?? `Level ${level}`}</p>
          {info?.handle && <p className="font-mono text-[13px] text-inkSoft">@{info.handle}</p>}
          {info?.email && (
            <p className="font-mono text-[13px] text-inkSoft">
              {info.email} {info.email_verified ? '· verified' : '· unverified'}
            </p>
          )}
        </div>
      </Card>

      {level < 3 && (
        <Card fillClassName="bg-paper2" shadow="sm">
          <div className="flex flex-col gap-2">
            <h2 className="font-display font-semibold text-[18px] text-ink">Become a verified creator</h2>
            <p className="font-body font-bold text-[14px] text-inkSoft">
              Publishing paid listings needs identity verification (KYC). Start a listing and we'll walk you
              through it, or finish verification in the app.
            </p>
            <a href="/dashboard/listings/new" className="mt-1 inline-block w-fit rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink no-underline shadow-zine-xs">
              Create a listing
            </a>
          </div>
        </Card>
      )}
    </div>
  );
}

export function SettingsPanel() {
  return (
    
      <Inner />
    
  );
}

export default SettingsPanel;
