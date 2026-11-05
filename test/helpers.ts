// The tests run in India's time zone, like the Android and iPhone tests, so "a day" means the same thing everywhere.
// Must run before any Date is used, so every test file imports this one first.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'Asia/Kolkata';

import { createRequire } from 'node:module';
import { AppError } from '../src/core/errors';
import { runCloudSync, type CloudSyncReport } from '../src/core/cloudsync';
import { toInstant, type Id, type Instant } from '../src/core/ids';
import { MemoryKV } from '../src/core/storage';
import {
  SheetSyncClient, SheetSyncError, type TransportReply,
} from '../src/core/sheetsync';
import { Actor, SyncClock } from '../src/core/syncrecord';
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

// ------------------------------------------------------------------ The real sheet script and simulated phones

// The tests run the real cloud/Code.gs against a fake of Google's classes, so the app and the script are tested together.
const requireNode = createRequire(import.meta.url);
const { makeEnv } = requireNode('../cloud/fake-google.js') as { makeEnv: (token?: string) => ScriptEnv };

interface ScriptEnv {
  call: (body: unknown) => Record<string, unknown>;
  sheets: Record<string, { grid: unknown[][] }>;
  ctx: { SpreadsheetApp: { getActiveSpreadsheet: () => { insertSheet: (n: string) => { grid: unknown[][] } } } };
  advance: (ms: number) => void;
  props: Record<string, string>;
}

export const SETUP_CODE = 'setup-code-0123456789';
export const PASSWORD = 'correct horse battery';

export interface Login { session: string; id: Id; name: string; role: 'Owner' | 'Manager' | 'Staff' }

/** Plays the sheet: the real Code.gs, with a first Owner created. */
export class FakeSheet {
  env = makeEnv(SETUP_CODE);
  actions: string[] = [];
  /** Runs once, just before the next push reaches the script: stands in for someone else syncing in between. */
  sneak: (() => void) | null = null;
  owner: Login;
  client = new SheetSyncClient(async (_url, body): Promise<TransportReply> => {
    const action: string = JSON.parse(body).action;
    this.actions.push(action);
    if (action === 'push' && this.sneak) { const f = this.sneak; this.sneak = null; f(); }
    return { status: 200, body: JSON.stringify(this.env.call(body)) };
  });

  constructor() {
    const r = this.env.call({ action: 'setupOwner', token: SETUP_CODE, name: 'Asha Rao', password: PASSWORD, device: 'Test' }) as
      { session: string; person: { id: Id } };
    this.owner = { session: r.session, id: r.person.id, name: 'Asha Rao', role: 'Owner' };
  }

  /** Invites a person and has them join. */
  addPerson(name: string, role: Login['role']): Login {
    const inv = this.env.call({ action: 'invite', session: this.owner.session, name, role }) as { code: string };
    const j = this.env.call({ action: 'join', invite: inv.code, password: 'a-good-password-1', device: 'Test' }) as { session: string; person: { id: Id } };
    return { session: j.session, id: j.person.id, name, role };
  }

  /** The record lines of one tab, as stored in the sheet. */
  lines(tab: string): string[] {
    const grid = this.env.sheets[tab]?.grid ?? [];
    const col = (grid[0] ?? []).indexOf('Record (JSON)');
    return grid.slice(1).map((r) => String(r[col])).filter((c) => c.startsWith('{'));
  }

  /** Puts raw rows into a tab, the way a person (or a newer app) could. */
  putRaw(tab: string, jsonLines: string[]) {
    const sheet = this.env.sheets[tab] ?? this.env.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet(tab);
    sheet.grid = [['Id', 'Record (JSON)'], ...jsonLines.map((l, i) => [String(i), l])];
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
  /** Who is signed in on this phone. Defaults to the sheet's first Owner. */
  login: Login | null = null;

  constructor(seed: () => Trek[] = () => []) {
    this.treks = new TrekStore(this.kv, seed);
    this.bookings = new BookingStore(this.kv);
    this.ledger = new LedgerStore(this.kv);
    this.vendors = new VendorStore(this.kv);
    this.guidance = new GuidanceStore(this.kv);
    this.settings = new SettingsStore(this.kv);
  }

  /** Makes this phone's person the one the stores stamp as author. */
  as(login: Login): this { this.login = login; Actor.id = login.id; return this; }

  sync(sheet: FakeSheet, dismissed: Set<string> = new Set()): Promise<CloudSyncReport> {
    const who = this.login ?? sheet.owner;
    return runCloudSync({
      client: sheet.client, address: 'https://script.google.com/macros/s/x/exec', session: who.session, device: 'Android',
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
