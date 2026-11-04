/** Small key-value storage, so the stores can be tested without a browser. */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
}

export class MemoryKV implements KV {
  map = new Map<string, string>();
  failWrites = false;
  get(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  set(key: string, value: string) { if (this.failWrites) return false; this.map.set(key, value); return true; }
  remove(key: string) { this.map.delete(key); }
}

/** localStorage, with every call guarded: it can throw in a private window, when full, or when site data is blocked. */
export class LocalKV implements KV {
  /** True once a write has failed, so the app can warn that changes are not being saved. */
  writeFailed = false;
  private listeners = new Set<() => void>();

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  set(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      if (this.writeFailed) { this.writeFailed = false; this.listeners.forEach((f) => f()); }
      return true;
    } catch {
      if (!this.writeFailed) { this.writeFailed = true; this.listeners.forEach((f) => f()); }
      return false;
    }
  }
  remove(key: string) { try { localStorage.removeItem(key); } catch { /* nothing to do */ } }
}

/** A tiny observable: screens subscribe and re-render when a store changes. */
export class Observable {
  private subs = new Set<() => void>();
  /** Bumps on every change, so a screen can tell whether anything moved. */
  rev = 0;
  subscribe = (fn: () => void): (() => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  protected emit() { this.rev++; this.subs.forEach((f) => f()); }
}

/** A list of records kept as one JSON array under one key. */
export class JsonListFile<T> {
  constructor(private kv: KV, private key: string, private parse: (o: unknown) => T | null) {}

  /**
   * Returns null when nothing is saved. A saved list that cannot be read is moved aside under another key
   * (never overwritten) and treated as missing, so a bad save never destroys the only copy.
   */
  read(): T[] | null {
    const raw = this.kv.get(this.key);
    if (raw === null) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error('not a list');
      const out: T[] = [];
      for (const o of arr) {
        const r = this.parse(o);
        if (r === null) throw new Error('unreadable record');
        out.push(r);
      }
      return out;
    } catch {
      this.kv.set(`${this.key}.unreadable-${Date.now()}`, raw);
      return null;
    }
  }

  write(list: T[]): boolean {
    return this.kv.set(this.key, JSON.stringify(list));
  }
}
