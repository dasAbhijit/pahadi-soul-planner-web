import { toInstant } from './ids';
import { duplicateGroups, decodeTables, mergeData, recordCount, type SeatConflict, type SyncData } from './syncmerge';
import { SheetSyncClient, SheetSyncError, buildTables, cleanName } from './sheetsync';
import type { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from './stores';

/** What a sync did, in words staff can read. */
export interface CloudSyncReport {
  received: number;
  sent: number;
  duplicates: number;
  overbooked: SeatConflict[];
  written: Record<string, number>;
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
  return parts.join(' ');
}

/**
 * Merge sync: read the sheet back, merge it with this phone by record id (the version changed last wins, entries
 * added elsewhere are all kept), recompute seats, then write the merged result.
 */
export async function runCloudSync(o: {
  client?: SheetSyncClient; address: string; token: string; user: string; device: string;
  treks: TrekStore; bookings: BookingStore; ledger: LedgerStore; vendors: VendorStore; guidance: GuidanceStore;
  dismissedDuplicates?: Set<string>; attempts?: number; now?: Date;
}): Promise<CloudSyncReport> {
  const client = o.client ?? new SheetSyncClient();
  if (cleanName(o.user) === '') throw new SheetSyncError('nameRequired');

  for (let attempt = 0; attempt < Math.max(1, o.attempts ?? 3); attempt++) {
    const pulled = await client.pull(o.address, o.token);
    const remote = decodeTables(pulled.tables);
    const local: SyncData = {
      treks: o.treks.syncRecords, bookings: o.bookings.syncRecords, ledger: o.ledger.syncRecords,
      vendors: o.vendors.syncRecords, guidance: o.guidance.syncRecords,
    };
    const { data: merged, report } = mergeData(local, remote);
    if (recordCount(merged) === 0) throw new SheetSyncError('nothingToSync');

    o.treks.applyMerged(merged.treks);
    o.bookings.applyMerged(merged.bookings);
    o.ledger.applyMerged(merged.ledger);
    o.vendors.applyMerged(merged.vendors);
    o.guidance.applyMerged(merged.guidance);

    try {
      const result = await client.push(buildTables(merged), o.address, o.token, o.user, o.device, pulled.version, toInstant(o.now ?? new Date()));
      const groups = duplicateGroups(merged.ledger, o.dismissedDuplicates ?? new Set());
      return { received: report.received, sent: report.sent, duplicates: groups.length, overbooked: report.overbooked, written: result.written };
    } catch (e) {
      // Someone else synced between our read and our write: read again and merge again.
      if (!(e instanceof SheetSyncError && e.code === 'changedMeanwhile')) throw e;
    }
  }
  throw new SheetSyncError('busy');
}
