import { Actor } from './syncrecord';
import { Observable, type KV } from './storage';
import type { Instant, Id } from './ids';
import type { DirectoryEntry, EndReason, Me } from './sheetsync';
import type { Role } from './roles';

interface Saved {
  person?: Me;
  directory?: DirectoryEntry[];
  signedInAt?: Instant;
  sheetName?: string;
  /** Set when the sheet ended this phone's session, so the app can explain why. */
  ended?: Exclude<EndReason, 'unknown'>;
}

const KEY = 'pahadi.account';
const SESSION_KEY = 'pahadi.secret.session';

/**
 * Who is signed in on this phone. The session code is the only secret: it proves who is asking and carries no
 * password. It sits apart from the other details, like the Gemini key. A browser has no vault, so both are
 * unencrypted in this browser's storage.
 */
export class AccountStore extends Observable {
  private data: Saved = {};

  constructor(private kv: KV) {
    super();
    try {
      const raw = kv.get(KEY);
      const parsed = raw === null ? {} : JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed as Saved;
    } catch { /* start signed out */ }
    Actor.id = this.signedIn ? this.data.person?.id : undefined;
  }

  private save() {
    for (const k of Object.keys(this.data) as (keyof Saved)[]) if (this.data[k] === undefined) delete this.data[k];
    this.kv.set(KEY, JSON.stringify(this.data));
    Actor.id = this.signedIn ? this.data.person?.id : undefined;
    this.emit();
  }

  get session(): string | null { return this.kv.get(SESSION_KEY) || null; }
  get signedIn(): boolean { return this.session !== null && this.data.person !== undefined; }
  get person(): Me | undefined { return this.signedIn ? this.data.person : undefined; }
  get role(): Role | undefined { return this.person?.role; }
  get myId(): Id | undefined { return this.person?.id; }
  get signedInAt(): Instant | undefined { return this.data.signedInAt; }
  get sheetName(): string | undefined { return this.data.sheetName; }
  get directory(): DirectoryEntry[] { return this.data.directory ?? []; }
  get ended(): Saved['ended'] { return this.data.ended; }

  /** The full name of a person, or undefined for a record from before sign-in or an unknown id. */
  nameOf(id: Id | undefined): string | undefined {
    if (id === undefined) return undefined;
    return this.directory.find((d) => d.id === id)?.name;
  }

  /** The first name, for "by Rohit" under a row. */
  firstNameOf(id: Id | undefined): string | undefined {
    return this.nameOf(id)?.split(' ')[0];
  }

  signIn(r: { session: string; person: Me; directory: DirectoryEntry[]; spreadsheet: string }, now: Instant) {
    this.kv.set(SESSION_KEY, r.session);
    this.data = { person: r.person, directory: r.directory, signedInAt: now, sheetName: r.spreadsheet };
    this.save();
  }

  /** What the sheet says now: the person may have a new role, and the directory may have new names. */
  refresh(person: Me, directory: DirectoryEntry[]) {
    this.data = { ...this.data, person, directory };
    this.save();
  }

  /** Signs out. `ended` records why when the sheet did it, so the app can show the "access removed" screen. */
  end(reason?: Exclude<EndReason, 'unknown'>) {
    this.kv.remove(SESSION_KEY);
    this.data = reason ? { ended: reason } : {};
    this.save();
  }

  clearEnded() {
    this.data = { ...this.data, ended: undefined };
    this.save();
  }
}
