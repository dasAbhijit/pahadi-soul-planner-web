import { changedFrom, decodeTables, duplicateGroups, mergeData, recordCount, type SeatConflict, type SyncData } from './syncmerge';
import { SheetSyncClient, SheetSyncError, buildTables, type DirectoryEntry, type Me } from './sheetsync';
import { limitToRole, limitToWritable } from './roles';
import type { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from './stores';

/** What a sync did, in words staff can read. */
export interface CloudSyncReport {
  received: number;
  sent: number;
  duplicates: number;
  overbooked: SeatConflict[];
  written: Record<string, number>;
  /** Changes the sheet did not accept, with the sheet's reason. Normally empty. */
  refused: { table: string; id: string; reason: string }[];
  person: Me;
  directory: DirectoryEntry[];
}

export function syncSummary(r: CloudSyncReport): string {
  const parts: string[] = [];
  if (r.received === 0 && r.sent === 0) parts.push('Everything was already in step.');
  else {
    const bits: string[] = [];
    if (r.received > 0) bits.push(`took ${r.received} new or changed from others`);
    if (r.sent > 0) bits.push(`sent ${r.sent}`);
    parts.push('Synced: ' + bits.join(', ') + '.');
  }
  if (r.duplicates > 0) parts.push(`${r.duplicates} possible duplicate payment${r.duplicates === 1 ? '' : 's'} to review in Money.`);
  for (const c of r.overbooked) parts.push(`${c.trekName} is overbooked by ${c.by} seat${c.by === 1 ? '' : 's'}.`);
  if (r.refused.length > 0) parts.push(`${r.refused.length} change${r.refused.length === 1 ? ' was' : 's were'} not accepted: ${r.refused[0].reason}`);
  return parts.join(' ');
}

/**
 * Merge sync. Reads what the sheet holds for this person's role, merges it with this phone by record id (the
 * version changed last wins, entries added elsewhere are all kept), recomputes seats, then sends only the records
 * the sheet does not already have. The sheet merges each one in itself, so two people syncing at once never
 * overwrite each other and nothing needs to be retried.
 */
export async function runCloudSync(o: {
  client?: SheetSyncClient; address: string; session: string; device: string;
  treks: TrekStore; bookings: BookingStore; ledger: LedgerStore; vendors: VendorStore; guidance: GuidanceStore;
  dismissedDuplicates?: Set<string>;
}): Promise<CloudSyncReport> {
  const client = o.client ?? new SheetSyncClient();
  const pulled = await client.pull(o.address, o.session, o.device);
  const { person, directory } = pulled;
  const remote = decodeTables(pulled.tables);
  const local: SyncData = limitToRole({
    treks: o.treks.syncRecords, bookings: o.bookings.syncRecords, ledger: o.ledger.syncRecords,
    vendors: o.vendors.syncRecords, guidance: o.guidance.syncRecords,
  }, person.role);
  // Staff cannot change treks, vendors or rules, so whatever this phone holds of them is only ever the sheet's copy.
  let counted = mergeData(local, remote).report;
  if (person.role === 'Staff') {
    local.treks = remote.treks; local.vendors = remote.vendors; local.guidance = remote.guidance;
    counted = { ...mergeData(local, remote).report, received: counted.received };
  }
  const { data: merged, report: settled } = mergeData(local, remote);
  const report = { ...settled, received: counted.received };
  if (recordCount(merged) === 0) throw new SheetSyncError('nothingToSync');

  o.treks.applyMerged(merged.treks);
  o.bookings.applyMerged(merged.bookings);
  o.ledger.applyMerged(merged.ledger);
  o.vendors.applyMerged(merged.vendors);
  o.guidance.applyMerged(merged.guidance);

  const changed = limitToWritable(changedFrom(merged, remote), person.role, person.id);
  let written: Record<string, number> = {};
  let refused: CloudSyncReport['refused'] = [];
  let sent = 0;
  if (recordCount(changed) > 0) {
    const result = await client.push(buildTables(changed, merged).filter((t) => t.rows.length > 0), o.address, o.session, o.device);
    written = result.accepted;
    refused = result.rejected;
    sent = Object.values(result.accepted).reduce((s, n) => s + n, 0);
  }
  const groups = duplicateGroups(merged.ledger, o.dismissedDuplicates ?? new Set());
  return { received: report.received, sent, duplicates: groups.length, overbooked: report.overbooked, written, refused, person, directory };
}
