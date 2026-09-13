// [AGENT-LIVE-1] "Test call" — creates a 3-min is_test=1 booking with no hold
// and no memory, then opens /talk/<bookingId> in a new tab. BUILD SPEC §3 M11.
import { useState } from 'react';
import { adminTestCall, ApiError } from '../../lib/agentLive';
import { capture, captureException } from '../../lib/analytics';

export default function TestCallButton({ agentId, disabled }: { agentId: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { talkPath } = await adminTestCall(agentId);
      capture('agent_admin_save', { outcome: 'test_call_ok' });
      window.open(talkPath, '_blank', 'noopener');
    } catch (e) {
      const msg = e instanceof ApiError ? e.error : 'Could not start a test call.';
      setError(msg);
      captureException(e, { where: 'agent_admin_test_call', agentId });
      capture('agent_admin_save', { outcome: 'test_call_error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void run()}
        className="rounded-full border-zine border-ink bg-blue px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-blueInk shadow-zine-xs disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Test call'}
      </button>
      {error && <span className="font-body text-[12px] font-bold text-coral">{error}</span>}
    </div>
  );
}
