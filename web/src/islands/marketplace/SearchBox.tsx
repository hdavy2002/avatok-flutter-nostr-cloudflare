import { useEffect, useRef, useState } from 'react';

export interface SearchBoxProps {
  value: string;
  onChange: (q: string) => void;
  /** Debounce window in ms (default 350). */
  debounce?: number;
  placeholder?: string;
}

/**
 * The bazaar search strip: a pill field with a hard ink border and offset
 * shadow, and a coral KHOJO button.
 *
 * [MARKET-BAZAAR-1 2026-08-31] Restyled from the plain zine <Field> to the
 * comp's search strip (design/marketplace/avaTOK Marketplace.dc.html). The
 * BEHAVIOUR is unchanged and deliberately so: typing still debounces up to
 * ExploreGrid, which calls /api/explore/search. The comp's button is wired to
 * `noop` — here it submits, so the field works for someone who types and hits
 * the button (or Enter) before the debounce fires, and for anyone driving the
 * page by keyboard.
 *
 * The label is visually hidden rather than deleted: the comp shows a bare input
 * with only a placeholder, and a placeholder is not an accessible name.
 */
export function SearchBox({
  value,
  onChange,
  debounce = 350,
  placeholder = 'Dhoondo: tarot, adda, rizz, shayari, antakshari…',
}: SearchBoxProps) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local in sync if the parent resets the query (e.g. clear filters).
  useEffect(() => setLocal(value), [value]);

  function handle(next: string) {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next.trim()), debounce);
  }

  function submit() {
    if (timer.current) clearTimeout(timer.current);
    onChange(local.trim());
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-1 items-center gap-2.5 rounded-full border-zine border-ink bg-paper py-1.5 pl-5 pr-1.5 shadow-zine-sm focus-within:shadow-zine-focus"
    >
      <label htmlFor="bazaar-search" className="sr-only">
        Search the marketplace
      </label>
      <input
        id="bazaar-search"
        type="search"
        inputMode="search"
        autoComplete="off"
        placeholder={placeholder}
        value={local}
        onChange={(e) => handle(e.currentTarget.value)}
        className="min-w-0 flex-1 border-none bg-transparent py-2 font-body text-[16px] font-semibold text-ink outline-none placeholder:text-placeholder"
      />
      <button
        type="submit"
        className="flex-none rounded-full border-zine border-ink bg-coral px-6 py-2.5 font-display text-[14px] font-normal uppercase tracking-[0.06em] text-card transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px]"
      >
        Khojo
      </button>
    </form>
  );
}

export default SearchBox;
