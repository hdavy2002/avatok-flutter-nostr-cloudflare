// Illustrative token amounts for design review only. Never use for billing.
export const sampleBaseRate = 0.10;
export const previewExtras = [
  { value: 'recording', label: 'Recording', rate: 0.02 },
  { value: 'noise-cancellation', label: 'Noise cancellation', rate: 0.01 },
  { value: 'transcription', label: 'Transcriptions / captions', rate: 0.03 },
  { value: 'hls', label: 'HLS live streaming', rate: 0.04 },
  { value: 'rtmp-in', label: 'RTMP in', rate: 0.02 },
  { value: 'rtmp-out', label: 'RTMP out', rate: 0.03 },
] as const;

type UsageKey = 'participants' | 'duration' | 'sessions';
type Period = 'monthly' | 'yearly';
type UsageState = Record<UsageKey, number>;
const usageKeys: UsageKey[] = ['participants', 'duration', 'sessions'];

/** Local illustrative pricing only; no requests or real billing actions. */
function initPricingPreview(root: HTMLElement): void {
  if (root.dataset.initialized === 'true') return;
  root.dataset.initialized = 'true';
  const state: UsageState = { participants: 2, duration: 60, sessions: 1 };
  let period: Period = 'monthly';
  const format = (value: number): string => value.toLocaleString();
  const setResult = (key: string, value: string): void => {
    const output = root.querySelector<HTMLElement>(`[data-result="${key}"]`);
    if (output && output.textContent !== value) output.textContent = value;
  };
  const selectedLabel = (name: string): string =>
    root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.dataset.label ?? '';

  const render = (): void => {
    const multiplier = period === 'yearly' ? 12 : 1;
    const sessions = state.sessions * multiplier;
    const minutes = state.participants * state.duration * sessions;
    const periodLabel = period === 'yearly' ? 'per year' : 'per month';
    setResult('minutes', format(minutes));
    setResult('period', periodLabel);
    setResult('session-period', periodLabel);
    setResult('sessions', format(sessions));
    setResult('format', selectedLabel('pp-use-case'));
    setResult('quality', selectedLabel('pp-quality'));
    const selectedExtras = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="pp-addon"]:checked'))
      .map((input) => previewExtras.find((extra) => extra.value === input.value))
      .filter((extra): extra is typeof previewExtras[number] => extra !== undefined);
    // Work in hundredths of a token so selected extras add predictably.
    const rateHundredths = Math.round(sampleBaseRate * 100) + selectedExtras.reduce((sum, extra) => sum + Math.round(extra.rate * 100), 0);
    const rate = rateHundredths / 100;
    setResult('addons', format(selectedExtras.length));
    setResult('unit-rate', rate.toFixed(2));
    setResult('cost', (rate * minutes).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    setResult('cost-period', periodLabel);
    const lines = root.querySelector<HTMLElement>('[data-rate-lines]');
    if (lines) {
      const rows = [{ label: 'Base rate', rate: sampleBaseRate }, ...selectedExtras].map((extra) => {
        const row = document.createElement('div');
        const label = document.createElement('dt');
        const amount = document.createElement('dd');
        label.textContent = extra.label;
        amount.textContent = `${extra.label === 'Base rate' ? '' : '+'}${extra.rate.toFixed(2)}`;
        row.append(label, amount);
        return row;
      });
      lines.replaceChildren(...rows);
    }
    setResult('formula', `${format(state.participants)} ${state.participants === 1 ? 'person' : 'people'} × ${format(state.duration)} min × ${format(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`);
    setResult('projection', period === 'yearly'
      ? 'A 12-month projection, assuming the same usage every month.'
      : 'Based on your planned monthly usage.');
  };

  for (const key of usageKeys) {
    const field = root.querySelector<HTMLElement>(`[data-usage-field="${key}"]`);
    const number = field?.querySelector<HTMLInputElement>('input[type="number"]');
    const range = field?.querySelector<HTMLInputElement>('input[type="range"]');
    if (!number || !range) continue;
    const min = Number(range.min);
    const max = Number(range.max);
    const step = Number(range.step);
    const normalize = (value: number): number => {
      const bounded = Math.min(max, Math.max(min, value));
      return Math.min(max, Math.max(min, min + Math.round((bounded - min) / step) * step));
    };
    const paintRange = (): void => {
      range.style.setProperty('--pp-range-progress', `${((state[key] - min) / (max - min)) * 100}%`);
      const unit = key === 'duration' ? 'minutes' : key === 'participants'
        ? (state[key] === 1 ? 'person' : 'people')
        : (state[key] === 1 ? 'session per month' : 'sessions per month');
      range.setAttribute('aria-valuetext', `${state[key]} ${unit}`);
    };
    const commit = (): void => {
      // Empty and invalid entries restore the last accepted value, never zero/NaN.
      const value = number.valueAsNumber;
      if (number.value.trim() !== '' && Number.isFinite(value)) state[key] = normalize(value);
      number.value = String(state[key]);
      range.value = String(state[key]);
      paintRange();
      render();
    };
    number.addEventListener('input', () => {
      // Leave intermediate edits intact; bounds and step are normalized on commit.
      const value = number.valueAsNumber;
      if (number.value.trim() === '' || !Number.isFinite(value) || !number.validity.valid) return;
      state[key] = value;
      range.value = String(value);
      paintRange();
      render();
    });
    number.addEventListener('change', commit);
    number.addEventListener('blur', commit);
    number.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    range.addEventListener('input', () => {
      state[key] = normalize(range.valueAsNumber);
      number.value = String(state[key]);
      paintRange();
      render();
    });
    // Normalize browser-restored number values before the first summary render.
    const initialValue = number.valueAsNumber;
    if (number.value.trim() !== '' && Number.isFinite(initialValue)) state[key] = normalize(initialValue);
    number.value = String(state[key]);
    range.value = String(state[key]);
    paintRange();
  }

  root.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')
    .forEach((input) => input.addEventListener('change', render));
  root.querySelectorAll<HTMLButtonElement>('button[data-period]').forEach((button) => {
    button.addEventListener('click', () => {
      period = button.dataset.period === 'yearly' ? 'yearly' : 'monthly';
      root.querySelectorAll<HTMLButtonElement>('button[data-period]').forEach((option) => {
        option.setAttribute('aria-pressed', String(option.dataset.period === period));
      });
      render();
    });
  });
  render();
}

export function initPricingPreviews(): void {
  document.querySelectorAll<HTMLElement>('[data-pricing-preview]').forEach(initPricingPreview);
}
