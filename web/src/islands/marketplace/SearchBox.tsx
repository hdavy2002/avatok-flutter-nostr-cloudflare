import { useEffect, useRef, useState } from 'react';
import { Field } from '../../components';

export interface SearchBoxProps {
  value: string;
  onChange: (q: string) => void;
  /** Debounce window in ms (default 350). */
  debounce?: number;
  placeholder?: string;
}

/**
 * Debounced search input in the zine field chrome. Pushes the query up to the
 * grid (which calls /api/explore/search). Stateless beyond the debounce timer.
 */
export function SearchBox({ value, onChange, debounce = 350, placeholder = 'Search creators, classes, lives…' }: SearchBoxProps) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local in sync if the parent resets the query (e.g. clear filters).
  useEffect(() => setLocal(value), [value]);

  function handle(next: string) {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next.trim()), debounce);
  }

  return (
    <Field
      label="Search"
      lead="⌕"
      type="search"
      inputMode="search"
      autoComplete="off"
      placeholder={placeholder}
      value={local}
      onChange={(e) => handle(e.currentTarget.value)}
    />
  );
}

export default SearchBox;
