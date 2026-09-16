/** Opt-in deadline for finite reads only; mutations and live operations keep their contracts. */
export async function withDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    if (parent?.aborted) { onAbort(); return; }
    parent?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException('Request timed out. Please try again.', 'TimeoutError'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([interrupted, controller.signal.aborted
      ? Promise.reject(new DOMException('Request cancelled', 'AbortError'))
      : read(controller.signal)]);
  } finally {
    clearTimeout(timer);
    if (onAbort) parent?.removeEventListener('abort', onAbort);
  }
}
