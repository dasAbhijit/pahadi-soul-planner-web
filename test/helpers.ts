// The tests run in India's time zone, like the Android and iPhone tests, so "a day" means the same thing everywhere.
// Must run before any Date is used, so every test file imports this one first.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'Asia/Kolkata';

import { AppError } from '../src/core/errors';
import { runCloudSync, type CloudSyncReport } from '../src/core/cloudsync';
import { toInstant, type Id, type Instant } from '../src/core/ids';
import { MemoryKV } from '../src/core/storage';
import {
  SheetSyncClient, SheetSyncError, type TransportReply,
} from '../src/core/sheetsync';
import { SyncClock } from '../src/core/syncrecord';
import { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from '../src/core/stores';
import { SettingsStore } from '../src/core/settings';
import {
  makeEntry, type Booking, type LedgerEntry, type Trek,
} from '../src/core/models';
import { canonical } from '../src/core/codec';

/** Local midnight of a day, as an Instant. */
export const date = (y: number, m: number, d: number): Instant => toInstant(new Date(y, m - 1, d));
/** A local date and time, as an Instant. */
export const at = (y: number, m: number, d: number, h = 0, min = 0): Instant => toInstant(new Date(y, m - 1, d, h, min));
/** A moment given as seconds since 1970. */
export const sec = (s: number): Instant => toInstant(s * 1000);

export const ADDRESS = 'https://script.google.com/macros/s/AKfy/exec';
export const FUTURE: Instant = sec(4_000_000_000);

/** Runs a promise that should fail and returns what it failed with. */
export async function failure(p: Promise<unknown> | (() => Promise<unknown>)): Promise<unknown> {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return e; }
  throw new Error('should have thrown');
}

/** Runs a function that should throw and returns what it threw. */
export function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('should have thrown');
}

/** The error code of an AppError or SheetSyncError, or undefined if it is neither. */
export const codeOf = (e: unknown): string | undefined => (e instanceof AppError || e instanceof SheetSyncError ? e.code : undefined);

/** Tries something and returns its error (or null if it worked). */
export function attempt(fn: () => unknown): Error | null {
  try { fn(); return null; } catch (e) { return e as Error; }
}

export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Holds the clock still so stamps are predictable. Call from beforeEach; the returned object moves time. */
export function frozenClock(startSeconds = 1_000_000) {
  const clock = { seconds: startSeconds, tick(s = 60) { clock.seconds += s; }, restore() { SyncClock.provider = () => Date.now(); } };
  SyncClock.provider = () => clock.seconds * 1000;
  return clock;
}

// ------------------------------------------------------------------ A simulated sheet and phones

/** Plays the Apps Script: stores JSON lines per tab and a version, refuses a push based on an old version. */
export class FakeSheet {
  version = 0;
  tables: Record<string, string[]> = {};
  token = 's';
  actions: string[] = [];
  /** Runs once, just before the next push is checked: stands in for someone else syncing in between. */
  sneak: (() => void) | null = null;
  client = new SheetSyncClient((url, body) => this.post(url, body));

  private reply(o: unknown): TransportReply { return { status: 200, body: JSON.stringify(o) }; }

  async post(_url: string, body: string): Promise<TransportReply> {
    const req = JSON.parse(body);
    if (req.token !== this.token) return this.reply({ ok: false, error: 'Wrong secret code.' });
    const action: string = req.action;
    this.actions.push(action);
    switch (action) {
      case 'pull': return this.reply({ ok: true, version: this.version, tables: this.tables });
      case 'push': {
        if (this.sneak) { const f = this.sneak; this.sneak = null; f(); }
        if (req.baseVersion !== this.version) return this.reply({ ok: false, code: 'conflict', error: 'changed' });
        const written: Record<string, number> = {};
        for (const t of req.tables as { name: string; headers: string[]; rows: string[][] }[]) {
          const col = t.headers.indexOf('Record (JSON)');
          const lines = t.rows.map((r) => r[col]);
          if (lines.length === 0 && (this.tables[t.name]?.length ?? 0) > 0) continue;
          this.tables[t.name] = lines;
          written[t.name] = lines.length;
        }
        this.version += 1;
        return this.reply({ ok: true, written, keptAsIs: [], version: this.version });
      }
      default: return this.reply({ ok: true });
    }
  }
}

/** One phone: its own storage and its own set of stores. */
export class Phone {
  kv = new MemoryKV();
  treks: TrekStore;
  bookings: BookingStore;
  ledger: LedgerStore;
  vendors: VendorStore;
  guidance: GuidanceStore;
  settings: SettingsStore;

  constructor(seed: () => Trek[] = () => []) {
    this.treks = new TrekStore(this.kv, seed);
    this.bookings = new BookingStore(this.kv);
    this.ledger = new LedgerStore(this.kv);
    this.vendors = new VendorStore(this.kv);
    this.guidance = new GuidanceStore(this.kv);
    this.settings = new SettingsStore(this.kv);
  }

  sync(sheet: FakeSheet, user = 'Asha', dismissed: Set<string> = new Set()): Promise<CloudSyncReport> {
    return runCloudSync({
      client: sheet.client, address: 'https://script.google.com/macros/s/x/exec', token: 's', user, device: 'Android',
      treks: this.treks, bookings: this.bookings, ledger: this.ledger, vendors: this.vendors, guidance: this.guidance,
      dismissedDuplicates: dismissed,
    });
  }

  /** A credit tied to a booking and trip, the only kind the ledger accepts for money in. */
  pay(amount: number, trek: Trek, booking: Booking, day: Instant = sec(1_800_000_000)): LedgerEntry {
    return this.ledger.add(makeEntry({
      date: day, kind: 'Money in', amount, mode: 'UPI', bookingID: booking.id as Id, customerName: booking.travellers[0],
      shares: [{ trekID: trek.id, trekName: trek.name, amount }],
    }));
  }
}
