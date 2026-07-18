/* §5.8 Kill switches & config — live toggles for every PlatformConfig flag via
 * the EXISTING PUT /api/admin/config (audited). Confirm dialog on disable. */
import { useEffect, useState } from 'react';
import { AdminGate } from './AdminGate';
import { getConfig, putConfig } from './adminApi';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';

// Known boolean kill switches (PlatformConfig). minAppBuild handled separately.
// Every entry MUST exist in DEFAULTS in worker/src/routes/config.ts — putConfig
// rejects any key not in DEFAULTS (`unknown key`, 400), so a stale entry here is a
// switch that 400s when it's touched. ([M-D11 2026-07-18] simOnlyPhoneEnabled was
// exactly that, and was removed when phone OTP was deleted app-wide.)
const BOOL_FLAGS = [
  'liveEnabled', 'consultEnabled', 'conferenceEnabled', 'avavoiceEnabled', 'avavisionEnabled',
  'marketplaceEnabled', 'olxEnabled',
  'translationEnabled', 'translationGroupEnabled', 'donationsEnabled', 'brainEnabled', 'verseEnabled',
  'walletRealMoney', 'identityLadderEnabled', 'guestTierEnabled', 'workersAiLivenessEnabled',
  'avaAffiliateEnabled', 'affiliateAssetKitEnabled',
];

function Inner() {
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => { try { const c = await getConfig(); setCfg(c); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'failed'); } };
  useEffect(() => { void load(); }, []);

  const toggle = async (key: string, next: boolean) => {
    if (!next && !confirm(`Disable "${key}"? This affects live users immediately.`)) return;
    setBusy(key);
    try { const r = await putConfig({ [key]: next }); setCfg(r.config); } catch (e) { setErr(e instanceof Error ? e.message : 'update failed'); } finally { setBusy(null); }
  };

  if (!cfg) return <div className="flex items-center gap-3 p-6"><Spinner size={22} />{err && <span className="text-coral font-mono text-[12px]">{err}</span>}</div>;
  // Include any unknown boolean keys returned by the server too (future flags).
  const keys = Array.from(new Set([...BOOL_FLAGS, ...Object.keys(cfg).filter((k) => typeof cfg[k] === 'boolean')]));

  return (
    <div className="flex flex-col gap-3">
      {err && <p className="text-coral font-mono text-[12px]">{err}</p>}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {keys.map((k) => {
          const on = cfg[k] === true;
          return (
            <Card key={k} shadow="sm">
              <div className="flex items-center justify-between p-1">
                <span className="font-mono text-[13px] text-ink">{k}</span>
                <div className="flex items-center gap-2">
                  <Pill kind={on ? 'ok' : 'no'}>{on ? 'ON' : 'OFF'}</Pill>
                  <Button variant={on ? 'coral' : 'lime'} loading={busy === k} onClick={() => toggle(k, !on)}>{on ? 'Disable' : 'Enable'}</Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="font-mono text-[10px] text-inkMute">minAppBuild = {String(cfg.minAppBuild ?? 0)} (numeric; edit via API). Last-changed audit in the Audit tab.</p>
    </div>
  );
}

export default function FlagsPanel() { return <AdminGate><Inner /></AdminGate>; }
