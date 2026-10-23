/* [HF-MERCH-STUDIO-2] Undo / redo for immutable snapshots. Changes with the same `key` made within `windowMs` of each other (slider drags, typing) merge into one step. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;
  constructor(private present: T, private readonly limit = 100, private readonly windowMs = 900) {}

  get current(): T { return this.present; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  push(next: T, key?: string): void {
    if (next === this.present) return;
    const now = Date.now();
    const merge = !!key && key === this.lastKey && now - this.lastAt < this.windowMs && this.past.length > 0;
    if (!merge) { this.past.push(this.present); if (this.past.length > this.limit) this.past.shift(); }
    this.present = next;
    this.future = [];
    this.lastKey = key ?? null;
    this.lastAt = now;
  }
  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev; this.lastKey = null;
    return prev;
  }
  redo(): T | null {
    const nxt = this.future.pop();
    if (nxt === undefined) return null;
    this.past.push(this.present);
    this.present = nxt; this.lastKey = null;
    return nxt;
  }
}
