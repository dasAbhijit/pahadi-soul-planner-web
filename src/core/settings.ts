import { MAX_NAME_LENGTH } from './sheetsync';
import { DEFAULT_SYSTEM_PROMPT } from './prompt';
import { DEFAULT_MODEL } from './gemini';
import { Observable, type KV } from './storage';
import type { Instant } from './ids';

interface Saved {
  systemPrompt?: string;
  model?: string;
  lastBackupAt?: Instant;
  syncURL?: string;
  userName?: string;
  lastSyncAt?: Instant;
  dismissedDuplicates?: string[];
}

const KEY = 'pahadi.settings';

/**
 * Staff-editable settings: the base system prompt, the Gemini model name, and when the last backup was made.
 * Cloud sync keeps its address, the person's name and the last-sync time here. None of these go into a backup
 * file, and the Gemini key and sync secret are kept apart in `Secrets`.
 */
export class SettingsStore extends Observable {
  private data: Saved;

  constructor(private kv: KV) {
    super();
    let d: Saved = {};
    try {
      const raw = kv.get(KEY);
      const parsed = raw === null ? {} : JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) d = parsed as Saved;
    } catch { /* start from defaults */ }
    this.data = d;
  }

  private update(change: Partial<Saved>) {
    this.data = { ...this.data, ...change };
    for (const k of Object.keys(this.data) as (keyof Saved)[]) if (this.data[k] === undefined) delete this.data[k];
    this.kv.set(KEY, JSON.stringify(this.data));
    this.emit();
  }

  get systemPrompt(): string { return this.data.systemPrompt ?? DEFAULT_SYSTEM_PROMPT; }
  get model(): string { return this.data.model ?? DEFAULT_MODEL; }
  get lastBackupAt(): Instant | undefined { return this.data.lastBackupAt; }
  get syncUrl(): string { return this.data.syncURL ?? ''; }
  get userName(): string { return this.data.userName ?? ''; }
  get lastSyncAt(): Instant | undefined { return this.data.lastSyncAt; }
  /** Possible-duplicate payments staff chose to keep. Kept per phone, by the ids of the entries involved. */
  get dismissedDuplicates(): Set<string> { return new Set(this.data.dismissedDuplicates ?? []); }

  setSystemPrompt(v: string) { this.update({ systemPrompt: v }); }
  setModel(v: string) { this.update({ model: v }); }
  setLastBackupAt(v: Instant | undefined) { this.update({ lastBackupAt: v }); }
  setSyncUrl(v: string) { this.update({ syncURL: v }); }
  setUserName(v: string) { this.update({ userName: v.slice(0, MAX_NAME_LENGTH) }); }
  setLastSyncAt(v: Instant | undefined) { this.update({ lastSyncAt: v }); }
  dismissDuplicates(groupID: string) {
    const next = new Set(this.dismissedDuplicates);
    next.add(groupID);
    this.update({ dismissedDuplicates: [...next].sort() });
  }
  resetPrompt() { this.setSystemPrompt(DEFAULT_SYSTEM_PROMPT); }

  /** Forgets what belongs to the company or the person when someone signs out. The sheet address and model stay. */
  clearPersonal() {
    this.update({ systemPrompt: undefined, lastBackupAt: undefined, lastSyncAt: undefined, dismissedDuplicates: undefined, userName: undefined });
  }
}

/**
 * The Gemini key (and the sync secret an earlier version kept; sign-in replaced it). A browser has no keychain, so they sit in this browser's own storage,
 * unencrypted and never in a backup, never in the sheet, never sent anywhere except to Google.
 */
export class Secrets extends Observable {
  constructor(private kv: KV) { super(); }

  get geminiKey(): string | null { return this.kv.get('pahadi.secret.gemini') || null; }
  setGeminiKey(v: string | null) {
    if (v === null || v.trim() === '') this.kv.remove('pahadi.secret.gemini'); else this.kv.set('pahadi.secret.gemini', v.trim());
    this.emit();
  }

  get syncSecret(): string | null { return this.kv.get('pahadi.secret.sync') || null; }
  setSyncSecret(v: string | null) {
    if (v === null || v.trim() === '') this.kv.remove('pahadi.secret.sync'); else this.kv.set('pahadi.secret.sync', v.trim());
    this.emit();
  }
}
