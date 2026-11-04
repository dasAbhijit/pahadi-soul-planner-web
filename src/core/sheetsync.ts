import { dayKey, ms, stampKey, type Instant } from './ids';
import { encodeRecord } from './codec';
import { partySize, signedAmount, vendorTotalAgreed } from './models';
import type { SyncFields } from './models';
import type { SyncData } from './syncmerge';

/** One cell sent to the sheet: text, or a whole number (amounts, days, seats) so Sheets can add them up. */
export type SheetCell = string | number;

/** One tab of the sheet. The apps send every tab in full on each sync. */
export interface SheetTable { name: string; headers: string[]; rows: SheetCell[][] }

export const MAX_NAME_LENGTH = 40;
export const MAX_BODY_BYTES = 15_000_000;

const syncColumns = ['Updated at', 'Deleted at', 'Record (JSON)'];

export const treksHeaders = ['Trek ID', 'Name', 'Region', 'Days', 'Difficulty', 'Max altitude (ft)', 'Price per person (INR)',
  'Start date', 'Seats left', 'Highlights', 'Notes', ...syncColumns];
export const bookingsHeaders = ['Booking ID', 'Trek ID', 'Trek', 'Contact', 'All travellers', 'Party size', 'Phone', 'Payment',
  'Amount received (INR)', 'Booked on', 'Cancelled on', ...syncColumns];
export const moneyHeaders = ['Entry ID', 'Date', 'Type', 'Amount (INR)', 'Signed amount (INR)', 'Trip ID', 'Trip', 'Traveller',
  'Booking ID', 'Vendor', 'Vendor ID', 'Paid by', 'Note', 'Recorded on', ...syncColumns];
export const vendorsHeaders = ['Vendor ID', 'Name', 'Service', 'Contact', 'Phone', 'Rate (INR)', 'Rate unit', 'Tags', 'Notes',
  'Total agreed (INR)', 'Agreed per trip', 'Added on', ...syncColumns];
export const guidanceHeaders = ['Rule ID', 'Rule', 'Added on', ...syncColumns];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (id: string) => id.toUpperCase();

/**
 * Builds the tabs from the app's data, with the same tabs and columns as the iPhone and Android apps.
 * Each row ends with when it changed, when it was deleted, and the whole record as JSON: the first columns are for
 * people, the JSON column is what the apps read back when they merge.
 */
export function buildTables(data: SyncData): SheetTable[] {
  const { treks, bookings, ledger, vendors, guidance } = data;
  const t = (s: string | undefined): SheetCell => s ?? '';
  const n = (v: number | undefined): SheetCell => (v === undefined ? '' : v);
  const id = (s: string | undefined): SheetCell => (s ? key(s) : '');
  const tail = (r: SyncFields): SheetCell[] => [
    r.updatedAt ? stampKey(r.updatedAt) : '', r.deletedAt ? stampKey(r.deletedAt) : '', encodeRecord(r),
  ];

  const trekRows = [...treks].sort((a, b) =>
    Number(a.startDate === undefined) - Number(b.startDate === undefined) ||
    (a.startDate && b.startDate ? ms(a.startDate) - ms(b.startDate) : 0) ||
    cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(key(a.id), key(b.id)))
    .map((k) => [id(k.id), k.name, k.region, k.durationDays, k.difficulty, n(k.maxAltitudeFt), n(k.pricePerPerson),
      k.startDate ? dayKey(k.startDate) : '', n(k.seatsLeft), k.highlights, k.notes, ...tail(k)]);

  const bookingRows = [...bookings].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || cmp(key(a.id), key(b.id)))
    .map((b) => [id(b.id), id(b.trekID), treks.find((x) => x.id === b.trekID)?.name ?? '(deleted trek)',
      t(b.travellers[0]), b.travellers.join(', '), partySize(b), b.phone, b.payment, n(b.amountReceived),
      stampKey(b.createdAt), b.cancelledAt ? stampKey(b.cancelledAt) : '', ...tail(b)]);

  const moneyRows = [...ledger].sort((a, b) => ms(a.date) - ms(b.date) || ms(a.createdAt) - ms(b.createdAt) || cmp(key(a.id), key(b.id)))
    .map((e) => [id(e.id), dayKey(e.date), e.kind, e.amount, signedAmount(e),
      e.shares.map((s) => key(s.trekID)).join('; '), e.shares.map((s) => s.trekName).join('; '),
      t(e.customerName), id(e.bookingID), t(e.vendorName), id(e.vendorID), e.mode, e.note, stampKey(e.createdAt), ...tail(e)]);

  const vendorRows = [...vendors].sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(key(a.id), key(b.id)))
    .map((v) => [id(v.id), v.name, v.service, v.contactName, v.phone, n(v.rate), v.rateUnit, v.tags.join(', '), v.notes,
      vendorTotalAgreed(v), v.agreements.map((a) => `${a.trekName}: ${a.amount}`).join('; '), stampKey(v.createdAt), ...tail(v)]);

  const guidanceRows = [...guidance].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || cmp(key(a.id), key(b.id)))
    .map((r) => [id(r.id), r.text, stampKey(r.createdAt), ...tail(r)]);

  return [
    { name: 'Treks', headers: treksHeaders, rows: trekRows },
    { name: 'Bookings', headers: bookingsHeaders, rows: bookingRows },
    { name: 'Money', headers: moneyHeaders, rows: moneyRows },
    { name: 'Vendors', headers: vendorsHeaders, rows: vendorRows },
    { name: 'Guidance', headers: guidanceHeaders, rows: guidanceRows },
  ];
}

/** A name the sheet's log can show: one line, trimmed, at most 40 characters. Empty if nothing usable. */
export function cleanName(raw: string): string {
  return raw.split(/[\n\r]/).join(' ').trim().slice(0, MAX_NAME_LENGTH).trim();
}

export const rowCount = (tables: SheetTable[]) => tables.reduce((s, t) => s + t.rows.length, 0);

/** "12 treks, 8 bookings, 40 transactions, 5 vendors, 3 rules". Deleted records are not counted. */
export function describeTables(tables: SheetTable[]): string {
  const count = (name: string) => {
    const t = tables.find((x) => x.name === name);
    if (!t) return 0;
    const col = t.headers.indexOf('Deleted at');
    return col < 0 ? 0 : t.rows.filter((r) => r[col] === '').length;
  };
  return `${count('Treks')} treks, ${count('Bookings')} bookings, ${count('Money')} transactions, ${count('Vendors')} vendors, ${count('Guidance')} rules`;
}

// ------------------------------------------------------------------ Sending

export type SheetSyncErrorCode =
  | 'notSetUp' | 'nameRequired' | 'badAddress' | 'nothingToSync' | 'tooLarge' | 'offline' | 'network'
  | 'notTheScript' | 'rejected' | 'changedMeanwhile' | 'busy' | 'unreadableRows';

interface ErrorInfo { why?: string; count?: number; status?: number }

export class SheetSyncError extends Error {
  code: SheetSyncErrorCode;
  constructor(code: SheetSyncErrorCode, info: ErrorInfo = {}) {
    super(SheetSyncError.text(code, info));
    this.name = 'SheetSyncError';
    this.code = code;
  }

  private static text(code: SheetSyncErrorCode, info: ErrorInfo): string {
    switch (code) {
      case 'notSetUp': return 'Set up cloud sync first: add the web address and the secret code.';
      case 'nameRequired': return 'Add your name first, so the sheet shows who synced.';
      case 'badAddress': return "That isn't a Google Apps Script address. It should start with https://script.google.com/macros/ and end with /exec.";
      case 'nothingToSync': return 'There is no data in the app or the sheet yet, so there is nothing to sync.';
      case 'tooLarge': return 'There is too much data to send in one go.';
      case 'offline': return "No internet connection. Your data is safe on this phone. Try again when you're online.";
      case 'network': return `Couldn't reach Google: ${info.why ?? 'connection problem'}`;
      case 'notTheScript': return "The address didn't answer like the sync script. Check that it is deployed as a web app with access set to Anyone, and that the address ends in /exec.";
      case 'rejected': return info.why ?? 'The sheet refused the data.';
      case 'changedMeanwhile': return 'Someone else synced at the same moment.';
      case 'busy': return 'Others kept syncing at the same time. Nothing was lost. Try again in a minute.';
      case 'unreadableRows': {
        const c = info.count ?? 0;
        return `The sheet has ${c} row${c === 1 ? '' : 's'} this app can't read, perhaps from a newer version of the app. Update the app, then sync again. Nothing was changed.`;
      }
    }
  }
}

export interface SheetSyncResult { written: Record<string, number>; keptAsIs: string[]; version: number }

/** What the sheet holds: each tab's records as JSON lines, and the sheet's version number. */
export interface SheetPull { version: number; tables: Record<string, string[]> }

export interface TransportReply { status: number; body: string }

/** Sends one POST. Swapped for a fake in tests. Throws SheetSyncError('offline' | 'network') when the network fails. */
export type SheetTransport = (url: string, body: string) => Promise<TransportReply>;

/**
 * The real thing: fetch follows Google's redirect to the reply. The body is sent as text/plain so the browser
 * makes a "simple" request and skips the CORS preflight that Apps Script cannot answer; the body is still JSON.
 */
export const fetchTransport: SheetTransport = async (url, body) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST', body, redirect: 'follow', credentials: 'omit', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SheetSyncError('offline');
    if (e instanceof DOMException && e.name === 'AbortError') throw new SheetSyncError('offline');
    throw new SheetSyncError('network', {
      why: 'the request was blocked or did not arrive. Check the web address, that the script is deployed with access set to Anyone, and your connection.',
    });
  } finally {
    clearTimeout(timer);
  }
};

/** Only Google's own script hosts are accepted, so the secret code can't be sent anywhere else by mistake. */
export function validateAddress(address: string): URL | null {
  let u: URL;
  try { u = new URL(address.trim()); } catch { return null; }
  const ok = u.protocol === 'https:' && u.hostname === 'script.google.com' && u.username === '' && u.password === '' &&
    u.port === '' && u.search === '' && u.hash === '' && u.pathname.includes('/macros/') && u.pathname.endsWith('/exec');
  return ok ? u : null;
}

export class SheetSyncClient {
  constructor(private transport: SheetTransport = fetchTransport) {}

  /** Checks the address and secret without sending any data. Returns the sheet's name. */
  async ping(address: string, token: string): Promise<string> {
    const reply = await this.send(JSON.stringify({ token, action: 'ping' }), address);
    return typeof reply.spreadsheet === 'string' ? reply.spreadsheet : 'your sheet';
  }

  /** Reads everything the sheet holds, with its version number. */
  async pull(address: string, token: string): Promise<SheetPull> {
    const reply = await this.send(JSON.stringify({ token, action: 'pull' }), address);
    if (!Number.isInteger(reply.version)) throw new SheetSyncError('notTheScript', { status: 200 });
    const tables: Record<string, string[]> = {};
    const raw = reply.tables;
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        tables[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      }
    }
    return { version: reply.version as number, tables };
  }

  /**
   * Writes every table. `baseVersion` is the version that was pulled: if someone else wrote in between, the sheet
   * refuses with changedMeanwhile and nothing is overwritten.
   */
  async push(tables: SheetTable[], address: string, token: string, user: string, device: string, baseVersion: number,
    now: Instant = new Date().toISOString()): Promise<SheetSyncResult> {
    const name = cleanName(user);
    if (name === '') throw new SheetSyncError('nameRequired');
    if (rowCount(tables) === 0) throw new SheetSyncError('nothingToSync');
    const body = JSON.stringify({ token, action: 'push', user: name, device, sentAt: now, baseVersion, tables });
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new SheetSyncError('tooLarge');
    const reply = await this.send(body, address);
    const written: Record<string, number> = {};
    if (reply.written && typeof reply.written === 'object') {
      for (const [k, v] of Object.entries(reply.written as Record<string, unknown>)) {
        const num = typeof v === 'number' ? v : Number(v);
        if (Number.isInteger(num)) written[k] = num;
      }
    }
    const kept = Array.isArray(reply.keptAsIs) ? reply.keptAsIs.filter((x): x is string => typeof x === 'string') : [];
    return { written, keptAsIs: kept, version: Number.isInteger(reply.version) ? (reply.version as number) : baseVersion + 1 };
  }

  private async send(body: string, address: string): Promise<Record<string, unknown>> {
    if (!validateAddress(address)) throw new SheetSyncError('badAddress');
    const reply = await this.transport(address.trim(), body);
    let json: unknown;
    try { json = JSON.parse(reply.body); } catch { json = null; }
    const obj = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    if (!obj || typeof obj.ok !== 'boolean') throw new SheetSyncError('notTheScript', { status: reply.status });
    if (!obj.ok) {
      if (obj.code === 'conflict') throw new SheetSyncError('changedMeanwhile');
      throw new SheetSyncError('rejected', { why: typeof obj.error === 'string' ? obj.error : 'The sheet refused the data.' });
    }
    return obj;
  }
}
