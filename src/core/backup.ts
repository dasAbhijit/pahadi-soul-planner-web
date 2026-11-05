import { AppError } from './errors';
import { parseBooking, parseEntry, parseRule, parseTrek, parseVendor } from './codec';
import { dayKey, parseInstant, toInstant, ms, type Instant } from './ids';
import type { Booking, GuidanceRule, LedgerEntry, Trek, Vendor } from './models';
import type { SettingsStore } from './settings';
import { BookingStore, LedgerStore, MAX_AMOUNT, MAX_PARTY, TrekStore, VendorStore, type GuidanceStore } from './stores';

export const BACKUP_FORMAT = 'PahadiSoulBackup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 50_000_000;

/**
 * Everything the app stores, in one file staff can save anywhere and restore later, including on another
 * phone. The file layout matches the iPhone and Android apps' backups, so a backup moves between them.
 * The Gemini key and the sync secret are never included.
 */
export interface Backup {
  format: string;
  version: number;
  createdAt: Instant;
  treks: Trek[];
  bookings: Booking[];
  ledger: LedgerEntry[];
  vendors: Vendor[];
  guidance: GuidanceRule[];
  systemPrompt?: string;
  model?: string;
}

export function backupFilename(now = new Date()): string {
  return `PahadiSoul-backup-${dayKey(now)}.json`;
}

export function snapshot(s: {
  treks: TrekStore; bookings: BookingStore; ledger: LedgerStore; vendors: VendorStore; guidance: GuidanceStore; settings: SettingsStore;
}, now = new Date()): Backup {
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: toInstant(now), treks: s.treks.treks, bookings: s.bookings.bookings,
    ledger: s.ledger.entries, vendors: s.vendors.vendors, guidance: s.guidance.rules,
    systemPrompt: s.settings.systemPrompt, model: s.settings.model,
  };
}

export const encodeBackup = (b: Backup): string => JSON.stringify(b, null, 2);

/** Reads and checks a backup file. Nothing is changed until restore is called. */
export function decodeBackup(text: string): Backup {
  if (text.length > MAX_BACKUP_BYTES) throw new AppError('invalid', 'The backup is damaged or inconsistent: the file is too large');
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new AppError('notABackup', 'This file is not a Pahadi Soul backup.'); }
  const o = root as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.format !== BACKUP_FORMAT) throw new AppError('notABackup', 'This file is not a Pahadi Soul backup.');
  if (!Number.isInteger(o.version) || parseInstant(o.createdAt) === null) throw new AppError('notABackup', 'This file is not a Pahadi Soul backup.');
  if ((o.version as number) > BACKUP_VERSION) throw new AppError('newerVersion', 'This backup was made by a newer version of the app. Update the app first.');

  const list = <T,>(k: string, parse: (x: unknown) => T | null): T[] => {
    const v = o[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new AppError('notABackup', 'This file is not a Pahadi Soul backup.');
    return v.map((x) => {
      const r = parse(x);
      if (r === null) throw new AppError('notABackup', 'This file is not a Pahadi Soul backup.');
      return r;
    });
  };
  const backup: Backup = {
    format: BACKUP_FORMAT, version: o.version as number, createdAt: parseInstant(o.createdAt)!,
    treks: list('treks', parseTrek), bookings: list('bookings', parseBooking), ledger: list('ledger', parseEntry),
    vendors: list('vendors', parseVendor), guidance: list('guidance', parseRule),
    systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt : undefined,
    model: typeof o.model === 'string' ? o.model : undefined,
  };
  checkBackup(backup);
  return backup;
}

function checkBackup(b: Backup) {
  const unique = (ids: string[], name: string) => {
    if (new Set(ids).size !== ids.length) throw new AppError('invalid', `The backup is damaged or inconsistent: duplicate ${name}`);
  };
  unique(b.treks.map((t) => t.id), 'treks');
  unique(b.bookings.map((x) => x.id), 'bookings');
  unique(b.ledger.map((x) => x.id), 'transactions');
  unique(b.vendors.map((x) => x.id), 'vendors');
  unique(b.guidance.map((x) => x.id), 'rules');
  if (!b.ledger.every((e) => e.amount > 0 && e.amount <= MAX_AMOUNT)) throw new AppError('invalid', 'The backup is damaged or inconsistent: a transaction has an impossible amount');
  if (!b.bookings.every((x) => x.travellers.length > 0 && x.travellers.length <= MAX_PARTY)) {
    throw new AppError('invalid', 'The backup is damaged or inconsistent: a booking has no travellers or too many');
  }
}

/** Replaces everything in the app with the backup. Call decodeBackup first so a bad file changes nothing. */
export function restoreBackup(b: Backup, s: {
  treks: TrekStore; bookings: BookingStore; ledger: LedgerStore; vendors: VendorStore; guidance: GuidanceStore; settings: SettingsStore;
}) {
  checkBackup(b);
  s.treks.replaceAll(b.treks);
  s.bookings.replaceAll(b.bookings);
  s.ledger.replaceAll(b.ledger);
  s.vendors.replaceAll(b.vendors);
  s.guidance.replaceAll(b.guidance);
  if (b.systemPrompt && b.systemPrompt.trim() !== '') s.settings.setSystemPrompt(b.systemPrompt);
  if (b.model && b.model.trim() !== '') s.settings.setModel(b.model);
}

// ------------------------------------------------------------------ CSV

export const CSV_HEADER = ['Date', 'Type', 'Amount (INR)', 'Trip', 'Traveller', 'Vendor', 'Paid by', 'Note', 'Recorded by'];

/** Quotes a cell, and stops spreadsheet programs from running text that starts like a formula. */
export function csvEscape(cell: string): string {
  let s = cell;
  if (s !== '' && '=+-@\t\r'.includes(s[0])) s = "'" + s;
  if (/[,"\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** The money ledger as a spreadsheet file, oldest first. `nameOf` turns a person id into a name for "Recorded by". */
export function ledgerCsv(entries: LedgerEntry[], nameOf: (id: string | undefined) => string | undefined = () => undefined): string {
  const sorted = [...entries].sort((a, b) => ms(a.date) - ms(b.date) || ms(a.createdAt) - ms(b.createdAt));
  const lines = [CSV_HEADER.join(',')];
  for (const e of sorted) {
    const row = [dayKey(e.date), e.kind, String(e.amount), e.shares.map((s) => s.trekName).join('; '), e.customerName ?? '', e.vendorName ?? '', e.mode, e.note, nameOf(e.createdBy) ?? ''];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
