import type { Id } from './ids';
import type { Booking, LedgerEntry, Vendor } from './models';
import type { SyncData } from './syncmerge';

export const ROLES = ['Owner', 'Manager', 'Staff'] as const;
export type Role = (typeof ROLES)[number];

/** What each role can do. The sheet's script enforces the same rules, so a changed app cannot get around them. */
export type Capability =
  | 'seeMoneyOut'        // money out, trip totals, vendor payments and statements
  | 'seeVendorRates'     // vendor rates and agreed amounts
  | 'editTreks'          // add, edit, duplicate, delete treks and change seats
  | 'cancelBooking'
  | 'editAnyRecord'      // change or delete bookings and payments others made
  | 'editVendors'
  | 'editRules'          // learned rules (not the base prompt)
  | 'exportData'         // Export all data and the Transactions CSV
  | 'editPrompt'         // the base prompt
  | 'restoreBackup'
  | 'manageSheet'        // the sheet address
  | 'managePeople';

const MANAGER: Capability[] = ['seeMoneyOut', 'seeVendorRates', 'editTreks', 'cancelBooking', 'editAnyRecord', 'editVendors', 'editRules', 'exportData'];

export function can(role: Role | undefined, what: Capability): boolean {
  if (role === 'Owner') return true;
  if (role === 'Manager') return MANAGER.includes(what);
  return false;
}

export const ROLE_SUMMARY: Record<Role, string> = {
  Owner: 'can do everything, including people, the prompt, backups and the sheet address.',
  Manager: 'can manage treks, bookings, money, vendors and rules. Cannot manage people, the prompt, backups or the sheet address.',
  Staff: 'can chat, see treks, create and confirm bookings, and record payments received. They cannot see money out, vendor rates or totals.',
};

/** A booking this person may change: Managers and Owners any, Staff only their own live bookings. */
export function canEditBooking(role: Role | undefined, me: Id | undefined, b: Booking): boolean {
  if (can(role, 'editAnyRecord')) return true;
  return role === 'Staff' && me !== undefined && b.createdBy === me && b.cancelledAt === undefined;
}

/** A payment this person may change: Staff only the payments received that they recorded. */
export function canEditEntry(role: Role | undefined, me: Id | undefined, e: LedgerEntry): boolean {
  if (can(role, 'editAnyRecord')) return true;
  return role === 'Staff' && me !== undefined && e.kind === 'Money in' && e.createdBy === me;
}

/** Vendor with the parts a Staff person may not see taken out. */
export function withoutRates(v: Vendor): Vendor {
  const out: Vendor = { ...v, agreements: [] };
  delete out.rate;
  return out;
}

/** What a role may hold on the phone: Staff never keep money out, vendor rates or agreed amounts. */
export function limitToRole(data: SyncData, role: Role): SyncData {
  if (role !== 'Staff') return data;
  return {
    ...data,
    ledger: data.ledger.filter((e) => e.kind === 'Money in'),
    vendors: data.vendors.map((v) => (v.rate === undefined && v.agreements.length === 0 ? v : withoutRates(v))),
  };
}

/** Of the changed records, those this person's role may send. The sheet refuses the rest, so they are not sent. */
export function limitToWritable(data: SyncData, role: Role, me: Id): SyncData {
  if (role !== 'Staff') return data;
  return {
    treks: [], vendors: [], guidance: [],
    bookings: data.bookings.filter((b) => b.deletedAt === undefined && b.cancelledAt === undefined && (b.createdBy === me || b.createdBy === undefined)),
    ledger: data.ledger.filter((e) => e.kind === 'Money in' && e.deletedAt === undefined && (e.createdBy === me || e.createdBy === undefined)),
  };
}
