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
 * `context` is everything the app holds, used to look up a booking's trek name when `data` is only what changed.
 * Each row ends with when it changed, when it was deleted, and the whole record as JSON: the first columns are for
 * people, the JSON column is what the apps read back when they merge.
 */
export function buildTables(data: SyncData, context: SyncData = data): SheetTable[] {
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
    .map((b) => [id(b.id), id(b.trekID), context.treks.find((x) => x.id === b.trekID)?.name ?? '(deleted trek)',
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
  | 'notSetUp' | 'badAddress' | 'nothingToSync' | 'tooLarge' | 'offline' | 'network'
  | 'notTheScript' | 'scriptTooOld' | 'rejected' | 'unreadableRows'
  | 'badLogin' | 'locked' | 'badInvite' | 'inviteExpired' | 'badSetup' | 'setupDone' | 'forbidden' | 'sessionEnded'
  | 'updateApp' | 'badRequest' | 'nameTaken' | 'lastOwner' | 'notSignedIn';

/** Why a session ended: an Owner removed the person, an Owner reset their sign-in, or 90 days without a sync. */
export type EndReason = 'removed' | 'reset' | 'expired' | 'unknown';

interface ErrorInfo { why?: string; count?: number; status?: number; reason?: EndReason; triesLeft?: number }

export class SheetSyncError extends Error {
  code: SheetSyncErrorCode;
  reason?: EndReason;
  triesLeft?: number;
  constructor(code: SheetSyncErrorCode, info: ErrorInfo = {}) {
    super(SheetSyncError.text(code, info));
    this.name = 'SheetSyncError';
    this.code = code;
    this.reason = info.reason;
    this.triesLeft = info.triesLeft;
  }

  private static text(code: SheetSyncErrorCode, info: ErrorInfo): string {
    switch (code) {
      case 'notSetUp': return info.why ?? 'Set up cloud sync first: add the sheet address.';
      case 'badAddress': return "That isn't a Google Apps Script address. It should start with https://script.google.com/macros/ and end with /exec.";
      case 'nothingToSync': return 'There is no data in the app or the sheet yet, so there is nothing to sync.';
      case 'tooLarge': return 'There is too much data to send in one go.';
      case 'offline': return "No internet connection. Your data is safe on this phone. Try again when you're online.";
      case 'network': return `Couldn't reach Google: ${info.why ?? 'connection problem'}`;
      case 'notTheScript': return "The address didn't answer like the sync script. Check that it is deployed as a web app with access set to Anyone, and that the address ends in /exec.";
      case 'scriptTooOld': return "The sheet's script is an older version that has no sign-in. An Owner needs to paste the new Code.gs into Apps Script and deploy a new version (see cloud/README.md).";
      case 'badLogin': {
        const n = info.triesLeft;
        return n === undefined ? 'Wrong name or password.' : `Wrong name or password. ${n} ${n === 1 ? 'try' : 'tries'} left.`;
      }
      case 'unreadableRows': {
        const c = info.count ?? 0;
        return `The sheet has ${c} row${c === 1 ? '' : 's'} this app can't read, perhaps from a newer version of the app. Update the app, then sync again. Nothing was changed.`;
      }
      case 'notSignedIn': return 'Sign in first.';
      default: return info.why ?? 'The sheet refused the request.';
    }
  }
}

export interface Me { id: string; name: string; role: 'Owner' | 'Manager' | 'Staff' }
export interface DirectoryEntry { id: string; name: string }

/** What a sign-in, join or first-Owner step returns. */
export interface SessionReply { session: string; person: Me; directory: DirectoryEntry[]; spreadsheet: string }

/** What the sheet holds for this person's role: each tab's records as JSON lines, with who is asking. */
export interface SheetPull { version: number; tables: Record<string, string[]>; person: Me; directory: DirectoryEntry[] }

export interface PushResult { accepted: Record<string, number>; rejected: { table: string; id: string; reason: string }[]; version: number }

export type PersonStatus = 'active' | 'invited' | 'disabled';
export interface PersonRow {
  id: string; name: string; role: Me['role']; status: PersonStatus; createdAt: string; addedBy: string;
  lastSyncAt: string | null; devices: string[]; inviteExpiresAt: string | null; disabledAt: string | null;
  payments: number; bookings: number;
}
export interface InviteReply { code: string; expiresAt: string; person: Me }

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

/** Only Google's own script hosts are accepted, so a password can't be sent anywhere else by mistake. */
export function validateAddress(address: string): URL | null {
  let u: URL;
  try { u = new URL(address.trim()); } catch { return null; }
  const ok = u.protocol === 'https:' && u.hostname === 'script.google.com' && u.username === '' && u.password === '' &&
    u.port === '' && u.search === '' && u.hash === '' && u.pathname.includes('/macros/') && u.pathname.endsWith('/exec');
  return ok ? u : null;
}

// ---- Invites: "PSP1.<sheet address, base64url>.<code>"

const INVITE_PREFIX = 'PSP1';

const toB64Url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string): string | null => {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return null; }
};

/** The text an Owner sends: holds the sheet address and the one-time code. */
export function inviteText(address: string, code: string): string {
  return `${INVITE_PREFIX}.${toB64Url(address.trim())}.${code}`;
}

/**
 * Reads whatever was pasted: a whole invite, or just the code. A pasted message may have text around the invite,
 * so the invite is looked for inside it. Returns the address when the invite carries one.
 */
export function parseInvite(pasted: string): { address?: string; code: string } | null {
  const m = new RegExp(`${INVITE_PREFIX}\\.([A-Za-z0-9_-]+)\\.([A-Za-z0-9-]{12,16})`).exec(pasted);
  if (m) {
    const address = fromB64Url(m[1]);
    if (address !== null && validateAddress(address)) return { address: address.trim(), code: m[2] };
  }
  const code = pasted.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 12 ? { code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` } : null;
}

// ---- The client

export class SheetSyncClient {
  constructor(private transport: SheetTransport = fetchTransport) {}

  /** Asks whether the sheet still needs its first Owner. Needs no password. */
  async status(address: string): Promise<{ setupNeeded: boolean }> {
    let reply: Record<string, unknown>;
    try { reply = await this.send({ action: 'status' }, address); } catch (e) {
      // An older script answers every unknown request with a refusal.
      if (e instanceof SheetSyncError && e.code === 'rejected') throw new SheetSyncError('scriptTooOld');
      throw e;
    }
    return { setupNeeded: reply.setupNeeded === true };
  }

  async setupOwner(address: string, setupCode: string, name: string, password: string, device: string): Promise<SessionReply> {
    return this.sessionReply(await this.send({ action: 'setupOwner', token: setupCode, name: cleanName(name), password, device }, address));
  }

  async signIn(address: string, name: string, password: string, device: string): Promise<SessionReply> {
    return this.sessionReply(await this.send({ action: 'signIn', name: cleanName(name), password, device }, address));
  }

  async join(address: string, invite: string, password: string, device: string): Promise<SessionReply> {
    return this.sessionReply(await this.send({ action: 'join', invite, password, device }, address));
  }

  /** Who an invite is for, so the person can check it before choosing a password. */
  async previewInvite(address: string, invite: string): Promise<{ name: string; role: Me['role']; invitedBy: string; expiresAt: string }> {
    const r = await this.send({ action: 'invitePreview', invite }, address);
    if (typeof r.name !== 'string' || !['Owner', 'Manager', 'Staff'].includes(String(r.role))) throw new SheetSyncError('notTheScript', { status: 200 });
    return { name: r.name, role: r.role as Me['role'], invitedBy: typeof r.invitedBy === 'string' ? r.invitedBy : '', expiresAt: String(r.expiresAt ?? '') };
  }

  async signOut(address: string, session: string): Promise<void> {
    await this.send({ action: 'signOut', session }, address);
  }

  async changePassword(address: string, session: string, oldPassword: string, newPassword: string): Promise<void> {
    await this.send({ action: 'changePassword', session, oldPassword, newPassword }, address);
  }

  /** Checks the address and the session without sending any data. Returns the sheet's name. */
  async ping(address: string, session: string): Promise<string> {
    const reply = await this.send({ action: 'ping', session }, address);
    return typeof reply.spreadsheet === 'string' ? reply.spreadsheet : 'your sheet';
  }

  /** Reads what this person's role may see, with who the sheet says they are now. */
  async pull(address: string, session: string, device: string): Promise<SheetPull> {
    const reply = await this.send({ action: 'pull', session, device }, address);
    if (!Number.isInteger(reply.version)) throw new SheetSyncError('notTheScript', { status: 200 });
    const tables: Record<string, string[]> = {};
    const raw = reply.tables;
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        tables[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      }
    }
    return { version: reply.version as number, tables, person: this.me(reply.person), directory: this.directory(reply.directory) };
  }

  /**
   * Sends only the records that changed. The sheet merges them in one by one (the newer change wins), so nobody's
   * work is overwritten and nothing has to be retried.
   */
  async push(tables: SheetTable[], address: string, session: string, device: string): Promise<PushResult> {
    if (rowCount(tables) === 0) return { accepted: {}, rejected: [], version: -1 };
    const body = JSON.stringify({ action: 'push', session, device, tables });
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new SheetSyncError('tooLarge');
    const reply = await this.send(JSON.parse(body), address, body);
    const accepted: Record<string, number> = {};
    if (reply.accepted && typeof reply.accepted === 'object') {
      for (const [k, v] of Object.entries(reply.accepted as Record<string, unknown>)) if (Number.isInteger(v)) accepted[k] = v as number;
    }
    const rejected = Array.isArray(reply.rejected)
      ? (reply.rejected as unknown[]).flatMap((x) => {
        const o = x as Record<string, unknown>;
        return o && typeof o.reason === 'string' ? [{ table: String(o.table ?? ''), id: String(o.id ?? ''), reason: o.reason }] : [];
      })
      : [];
    return { accepted, rejected, version: Number.isInteger(reply.version) ? (reply.version as number) : -1 };
  }

  // ---- People (Owner only)

  async people(address: string, session: string): Promise<PersonRow[]> {
    const reply = await this.send({ action: 'people', session }, address);
    return Array.isArray(reply.people) ? (reply.people as PersonRow[]) : [];
  }

  async invite(address: string, session: string, who: { name: string; role: Me['role'] } | { personId: string }): Promise<InviteReply> {
    return this.inviteReply(await this.send({ action: 'invite', session, ...who }, address));
  }

  async setRole(address: string, session: string, personId: string, role: Me['role']): Promise<void> {
    await this.send({ action: 'setRole', session, personId, role }, address);
  }

  async removePerson(address: string, session: string, personId: string): Promise<void> {
    await this.send({ action: 'removePerson', session, personId }, address);
  }

  async resetSignIn(address: string, session: string, personId: string): Promise<InviteReply> {
    return this.inviteReply(await this.send({ action: 'resetSignIn', session, personId }, address));
  }

  // ---- Reading replies

  private me(o: unknown): Me {
    const p = o as Record<string, unknown> | null;
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !['Owner', 'Manager', 'Staff'].includes(String(p.role))) {
      throw new SheetSyncError('notTheScript', { status: 200 });
    }
    return { id: p.id.toUpperCase(), name: p.name, role: p.role as Me['role'] };
  }

  private directory(o: unknown): DirectoryEntry[] {
    if (!Array.isArray(o)) return [];
    return o.flatMap((x) => {
      const d = x as Record<string, unknown>;
      return d && typeof d.id === 'string' && typeof d.name === 'string' ? [{ id: d.id.toUpperCase(), name: d.name }] : [];
    });
  }

  private sessionReply(r: Record<string, unknown>): SessionReply {
    if (typeof r.session !== 'string' || r.session === '') throw new SheetSyncError('notTheScript', { status: 200 });
    return {
      session: r.session, person: this.me(r.person), directory: this.directory(r.directory),
      spreadsheet: typeof r.spreadsheet === 'string' ? r.spreadsheet : 'your sheet',
    };
  }

  private inviteReply(r: Record<string, unknown>): InviteReply {
    if (typeof r.code !== 'string' || typeof r.expiresAt !== 'string') throw new SheetSyncError('notTheScript', { status: 200 });
    return { code: r.code, expiresAt: r.expiresAt, person: this.me(r.person) };
  }

  private async send(request: Record<string, unknown>, address: string, raw?: string): Promise<Record<string, unknown>> {
    if (!validateAddress(address)) throw new SheetSyncError('badAddress');
    const reply = await this.transport(address.trim(), raw ?? JSON.stringify(request));
    let json: unknown;
    try { json = JSON.parse(reply.body); } catch { json = null; }
    const obj = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
    if (!obj || typeof obj.ok !== 'boolean') throw new SheetSyncError('notTheScript', { status: reply.status });
    if (!obj.ok) {
      const why = typeof obj.error === 'string' ? obj.error : 'The sheet refused the request.';
      const code = typeof obj.code === 'string' ? obj.code : '';
      const known: SheetSyncErrorCode[] = ['badLogin', 'locked', 'badInvite', 'inviteExpired', 'badSetup', 'setupDone', 'forbidden',
        'sessionEnded', 'updateApp', 'badRequest', 'nameTaken', 'lastOwner', 'notSetUp'];
      if ((known as string[]).includes(code)) {
        throw new SheetSyncError(code as SheetSyncErrorCode, {
          why, triesLeft: Number.isInteger(obj.triesLeft) ? (obj.triesLeft as number) : undefined,
          reason: ['removed', 'reset', 'expired', 'unknown'].includes(String(obj.reason)) ? (obj.reason as EndReason) : undefined,
        });
      }
      throw new SheetSyncError('rejected', { why });
    }
    return obj;
  }
}
