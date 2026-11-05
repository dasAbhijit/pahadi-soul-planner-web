import { FUTURE, FakeSheet, Phone, codeOf, failure, frozenClock, sec } from './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncSummary, type CloudSyncReport } from '../src/core/cloudsync';
import { buildTables } from '../src/core/sheetsync';
import {
  duplicateGroups, emptyData, mergeData, mergeRecords, reconcileSeats, type SeatConflict,
} from '../src/core/syncmerge';
import { MemoryKV } from '../src/core/storage';
import { TrekStore, seedTreks } from '../src/core/stores';
import { SettingsStore } from '../src/core/settings';
import { makeBooking, makeEntry, makeTrek, makeVendor, type Booking, type LedgerEntry, type Trek } from '../src/core/models';
import { newId, type Id, type Instant } from '../src/core/ids';

let clock: ReturnType<typeof frozenClock>;
beforeEach(() => { clock = frozenClock(1_000_000); });
afterEach(() => clock.restore());

const tick = (s = 60) => clock.tick(s);
const at = (s: number): Instant => sec(s);

const trek = (name = 'Kuari Pass', seats: number | undefined = 10, id: Id = newId()): Trek =>
  makeTrek({ id, name, durationDays: 6, pricePerPerson: 14500, startDate: FUTURE, seatsLeft: seats });

/** A trek with a stamp, the way a store hands it out. */
const stamped = <T extends { updatedAt?: Instant }>(r: T, s: number, extra: Partial<T> = {}): T => ({ ...r, updatedAt: at(s), ...extra });

const isDel = (r: { deletedAt?: Instant }) => r.deletedAt !== undefined;

// ---- Merging records

describe('merging records', () => {
  it('keeps entries added on different phones', () => {
    const a = makeEntry({ date: FUTURE, kind: 'Money in', amount: 5000, updatedAt: at(10) });
    const b = makeEntry({ date: FUTURE, kind: 'Money in', amount: 7000, updatedAt: at(20) });
    const m = mergeRecords([a], [b]);
    expect(new Set(m.merged.map((e) => e.id))).toEqual(new Set([a.id, b.id]));
    expect(m.received).toBe(1);
    expect(m.sent).toBe(1);
  });

  it('lets the later edit of the same record win on both phones', () => {
    const old = stamped(trek('Kuari Pass'), 100);
    const next = { ...old, name: 'Kuari Pass (new batch)', updatedAt: at(200) };
    expect(mergeRecords([old], [next]).merged).toEqual([next]);
    expect(mergeRecords([next], [old]).merged).toEqual([next]);
  });

  it('lets a deletion beat an older edit and an edit beat an older deletion', () => {
    const live = stamped(trek(), 100);
    const gone = { ...live, deletedAt: at(200), updatedAt: at(200) };
    expect(isDel(mergeRecords([live], [gone]).merged[0])).toBe(true);

    const edited = { ...live, name: 'Edited later', updatedAt: at(300) };
    const m = mergeRecords([gone], [edited]).merged[0];
    expect(isDel(m)).toBe(false);
    expect(m.name).toBe('Edited later');
  });

  it('lets a deletion as new as an edit win', () => {
    const live = stamped(trek(), 100);
    const gone = { ...live, deletedAt: at(100) };
    expect(isDel(mergeRecords([live], [gone]).merged[0])).toBe(true);
    expect(isDel(mergeRecords([gone], [live]).merged[0])).toBe(true);
  });

  it('merges the same in either order', () => {
    const a = stamped(trek('A'), 5);
    const b = stamped(trek('B'), 6);
    const a2 = { ...a, region: 'Hills', updatedAt: at(9) };
    const one = mergeRecords([a, b], [a2]).merged;
    const two = mergeRecords([a2], [a, b]).merged;
    expect(new Set(one.map((r) => r.id))).toEqual(new Set(two.map((r) => r.id)));
    expect(one.find((r) => r.id === a.id)).toEqual(two.find((r) => r.id === a.id));
  });
});

// ---- Seats

describe('seats', () => {
  it('are capacity minus live bookings', () => {
    const t = trek('Kuari Pass', 6);
    const live = makeBooking({ trekID: t.id, travellers: ['A', 'B'], phone: '1' });
    const cancelled = makeBooking({ trekID: t.id, travellers: ['C'], phone: '2', cancelledAt: FUTURE });
    const deleted = makeBooking({ trekID: t.id, travellers: ['D'], phone: '3', deletedAt: FUTURE });
    const { treks, conflicts } = reconcileSeats([t], [live, cancelled, deleted]);
    expect(conflicts).toEqual([]);
    expect(treks[0].seatCapacity).toBe(8); // 6 left + 2 booked, found from a trek that had no capacity yet
    expect(treks[0].seatsLeft).toBe(6);
  });

  it('add up after two phones book different people', () => {
    const t = stamped(trek('Kuari Pass', 5), 1, { seatCapacity: 5 });
    const a = stamped(makeBooking({ trekID: t.id, travellers: ['A', 'B'], phone: '1' }), 2);
    const b = stamped(makeBooking({ trekID: t.id, travellers: ['C'], phone: '2' }), 3);
    const { data, report } = mergeData(
      { treks: [{ ...t, seatsLeft: 3 }], bookings: [a], ledger: [], vendors: [], guidance: [] },
      { treks: [{ ...t, seatsLeft: 4 }], bookings: [b], ledger: [], vendors: [], guidance: [] });
    expect(data.treks[0].seatsLeft).toBe(2);
    expect(report.overbooked).toEqual([]);
  });

  it('are reported, not hidden, when more are taken than exist', () => {
    const t = stamped(trek('Kuari Pass', 3), 1, { seatCapacity: 3 });
    const a = makeBooking({ trekID: t.id, travellers: ['A', 'B'], phone: '1' });
    const b = makeBooking({ trekID: t.id, travellers: ['C', 'D'], phone: '2' });
    const { data, report } = mergeData(
      { treks: [t], bookings: [a], ledger: [], vendors: [], guidance: [] },
      { treks: [t], bookings: [b], ledger: [], vendors: [], guidance: [] });
    expect(data.treks[0].seatsLeft).toBe(0);
    expect(report.overbooked).toEqual<SeatConflict[]>([{ trekID: t.id, trekName: 'Kuari Pass', by: 1 }]);
  });

  it('leave undated treks and untracked seats alone', () => {
    const { treks, conflicts } = reconcileSeats([makeTrek({ name: 'Anytime' }), makeTrek({ name: 'No seats', startDate: FUTURE })], []);
    expect(conflicts).toEqual([]);
    expect(treks[0].seatCapacity).toBeUndefined();
    expect(treks[1].seatCapacity).toBeUndefined();
  });

  it('stay equal to capacity minus booked through confirm and cancel', () => {
    const p = new Phone();
    p.treks.upsert(trek('Kuari Pass', 8));
    let t = p.treks.treks[0];
    p.treks.upsert({ ...t, seatCapacity: 8 });
    t = p.treks.treks[0];
    const b = p.bookings.confirm({ trekID: t.id, travellers: ['A', 'B'], phone: '1', trekStore: p.treks });
    expect(p.treks.treks[0].seatsLeft).toBe(6);
    expect(p.treks.treks[0].seatCapacity).toBe(8);
    p.bookings.cancel(b.id, p.treks);
    expect(p.treks.treks[0].seatsLeft).toBe(8);
    p.treks.adjustCapacity(t.id, -1); // the minus button: one seat taken off the sale
    expect(p.treks.treks[0].seatCapacity).toBe(7);
    expect(p.treks.reconcileSeats(p.bookings.bookings)).toEqual([]);
    expect(p.treks.treks[0].seatsLeft).toBe(7);
  });

  it('do not restamp the trek on booking or cancelling, but the capacity button does', () => {
    const p = new Phone();
    p.treks.upsert({ ...trek('Kuari Pass', 8), seatCapacity: 8 });
    const stamp = p.treks.treks[0].updatedAt;
    tick();
    const t = p.treks.treks[0];
    const b = p.bookings.confirm({ trekID: t.id, travellers: ['A'], phone: '1', trekStore: p.treks });
    p.bookings.cancel(b.id, p.treks);
    expect(p.treks.treks[0].updatedAt).toBe(stamp);
    p.treks.adjustCapacity(t.id, 1);
    expect(p.treks.treks[0].updatedAt).toBe(at(1_000_060));
  });
});

// ---- Duplicates

const entry = (o: { amount?: number; booking: Id; trek: Id; day: Instant; id?: Id; created?: number }): LedgerEntry => {
  const amount = o.amount ?? 5000;
  return makeEntry({
    ...(o.id ? { id: o.id } : {}), date: o.day, kind: 'Money in', amount, bookingID: o.booking, customerName: 'Asha',
    shares: [{ trekID: o.trek, trekName: 'Kuari Pass', amount }], createdAt: at(o.created ?? 0),
  });
};

describe('duplicates', () => {
  it('flag the same payment typed twice, and never remove it', () => {
    const booking = newId(), tk = newId();
    const a = entry({ booking, trek: tk, day: FUTURE, created: 1 });
    const b = entry({ booking, trek: tk, day: FUTURE, created: 2 });
    const groups = duplicateGroups([a, b]);
    expect(groups.length).toBe(1);
    expect(groups[0].entries.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('do not flag different people, amounts, days and trips', () => {
    const booking = newId(), tk = newId();
    const base = entry({ booking, trek: tk, day: FUTURE });
    const twoDays = new Date(Date.parse(FUTURE) + 86_400_000 * 2).toISOString().replace('.000Z', 'Z');
    const others = [
      entry({ amount: 6000, booking, trek: tk, day: FUTURE }),
      entry({ booking: newId(), trek: tk, day: FUTURE }),
      entry({ booking, trek: newId(), day: FUTURE }),
      entry({ booking, trek: tk, day: twoDays }),
    ];
    for (const o of others) expect(duplicateGroups([base, o])).toEqual([]);
  });

  it('skip deleted entries, and keep-all sticks until another lookalike appears', () => {
    const booking = newId(), tk = newId();
    const a = entry({ booking, trek: tk, day: FUTURE, created: 1 });
    const b = entry({ booking, trek: tk, day: FUTURE, created: 2 });
    expect(duplicateGroups([a, { ...b, deletedAt: FUTURE }])).toEqual([]);

    const group = duplicateGroups([a, b])[0];
    expect(duplicateGroups([a, b], new Set([group.id]))).toEqual([]);
    const third = entry({ booking, trek: tk, day: FUTURE, created: 3 });
    expect(duplicateGroups([a, b, third], new Set([group.id])).length).toBe(1);
  });

  it('give a group id of upper-case ids joined like the iPhone app', () => {
    const booking = newId(), tk = newId();
    const a = entry({ booking, trek: tk, day: FUTURE, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', created: 1 });
    const b = entry({ booking, trek: tk, day: FUTURE, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', created: 2 });
    expect(duplicateGroups([b, a])[0].id).toBe('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA|BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB');
  });
});

// ---- Stores keep stamps and tombstones

describe('stamps and tombstones', () => {
  it('stamp edits and keep them through a reload', () => {
    const p = new Phone();
    p.treks.upsert(trek());
    expect(p.treks.treks[0].updatedAt).toBe(at(1_000_000));
    tick();
    p.treks.upsert({ ...p.treks.treks[0], name: 'Renamed' });
    expect(p.treks.treks[0].updatedAt).toBe(at(1_000_060));

    const again = new TrekStore(p.kv, () => []);
    expect(again.treks.map((t) => t.name)).toEqual(['Renamed']);
    expect(again.treks[0].updatedAt).toBe(at(1_000_060));
  });

  it('keep a tombstone through a reload and out of the screens', () => {
    const p = new Phone();
    const t = trek();
    p.treks.upsert(t);
    tick();
    p.treks.delete([t.id]);
    expect(p.treks.treks).toEqual([]);
    expect(p.treks.syncRecords.length).toBe(1);
    expect(p.treks.syncRecords[0].deletedAt).toBe(at(1_000_060));

    const again = new TrekStore(p.kv, () => []);
    expect(again.treks).toEqual([]);
    expect(again.syncRecords.length).toBe(1);
  });

  it('turn every store delete into a tombstone', () => {
    const p = new Phone();
    const t = trek();
    p.treks.upsert(t);
    const b = p.bookings.confirm({ trekID: t.id, travellers: ['Asha'], phone: '1', trekStore: p.treks });
    const e = p.pay(5000, t, b);
    const v = p.vendors.upsert(makeVendor({ name: 'Dorje' }));
    const r = p.guidance.add('Always mention the pickup point');

    p.ledger.remove(e.id);
    p.vendors.delete(v.id);
    p.guidance.remove(r.id);
    p.bookings.removeBookingsForTrek(t.id);

    expect(p.ledger.entries.length + p.vendors.vendors.length + p.guidance.rules.length + p.bookings.bookings.length).toBe(0);
    for (const s of [p.ledger.syncRecords, p.vendors.syncRecords, p.guidance.syncRecords, p.bookings.syncRecords]) {
      expect(s.length).toBe(1);
      expect(s.every(isDel)).toBe(true);
    }
  });

  it('treat undoing a rule change as a syncable change itself', () => {
    const p = new Phone();
    const r = p.guidance.add('Mention the pickup point');
    tick();
    p.guidance.undo(); // undo the add
    expect(p.guidance.rules).toEqual([]);
    expect(isDel(p.guidance.syncRecords[0])).toBe(true);
    tick();
    p.guidance.remove(r.id); // nothing there: no change, no crash
    expect(p.guidance.syncRecords.length).toBe(1);
  });

  it('make a restore authoritative and keep unchanged stamps', () => {
    const p = new Phone();
    const keep = trek('Keep'), drop = trek('Drop');
    p.treks.upsert(keep); p.treks.upsert(drop);
    const keepStamp = p.treks.treks.find((t) => t.id === keep.id)!.updatedAt;
    tick();
    const changed = { ...p.treks.treks.find((t) => t.id === keep.id)! };
    delete changed.updatedAt;
    p.treks.replaceAll([changed, trek('New')]);
    expect(new Set(p.treks.treks.map((t) => t.name))).toEqual(new Set(['Keep', 'New']));
    expect(p.treks.treks.find((t) => t.id === keep.id)!.updatedAt).toBe(keepStamp); // identical: untouched
    expect(p.treks.syncRecords.find((t) => t.id === drop.id)!.deletedAt).toBe(at(1_000_060)); // missing: deleted now
    expect(p.treks.treks.find((t) => t.name === 'New')!.updatedAt).toBe(at(1_000_060));
  });

  it('stamp files from before sync once and keep that stamp', () => {
    const kv = new MemoryKV();
    kv.set('pahadi.treks', '[{"id":"11111111-1111-1111-1111-111111111111","name":"Old","region":"","durationDays":3,"difficulty":"Easy","highlights":"","notes":""}]');
    const first = new TrekStore(kv, () => []);
    expect(first.treks[0].updatedAt).toBe(at(1_000_000));
    tick(3600);
    const second = new TrekStore(kv, () => []);
    expect(second.treks[0].updatedAt).toBe(at(1_000_000)); // not re-stamped on every launch
  });

  it('give every phone the same starter trek, which loses to any real edit', () => {
    const a = new Phone(seedTreks), b = new Phone(seedTreks);
    expect(a.treks.treks[0].id).toBe(b.treks.treks[0].id);
    expect(a.treks.treks[0].id).toBe('00000000-0000-4000-8000-000000000001');
    expect(a.treks.treks[0].updatedAt).toBe('1970-01-01T00:00:00Z');
    a.treks.upsert({ ...a.treks.treks[0], name: 'Real name' });
    const merged = mergeRecords(b.treks.syncRecords, a.treks.syncRecords).merged;
    expect(merged.length).toBe(1);
    expect(merged[0].name).toBe('Real name');
  });

  it('persist dismissed duplicates as a sorted JSON array', () => {
    const kv = new MemoryKV();
    const s = new SettingsStore(kv);
    s.dismissDuplicates('B|C'); s.dismissDuplicates('A|B');
    expect(JSON.parse(kv.get('pahadi.settings')!).dismissedDuplicates).toEqual(['A|B', 'B|C']);
    expect(new SettingsStore(kv).dismissedDuplicates).toEqual(new Set(['A|B', 'B|C']));
  });
});

// ---- Whole syncs through the simulated sheet

function setUpTrek(p: Phone, seats = 10): { t: Trek; b: Booking } {
  p.treks.upsert({ ...trek('Kuari Pass', seats), seatCapacity: seats });
  const t = p.treks.treks[0];
  const b = p.bookings.confirm({ trekID: t.id, travellers: ['Asha Rao'], phone: '1', trekStore: p.treks });
  return { t: p.treks.treks[0], b };
}

describe('whole syncs', () => {
  it('give a fresh phone everything the sheet holds', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const { t, b: bk } = setUpTrek(a);
    a.pay(5000, t, bk);
    a.vendors.upsert(makeVendor({ name: 'Dorje' }));
    a.guidance.add('Mention the pickup point');
    await a.sync(sheet);

    const report = await b.sync(sheet);
    expect(b.treks.treks.map((x) => x.name)).toEqual(['Kuari Pass']);
    expect(b.bookings.bookings.length).toBe(1);
    expect(b.ledger.entries.map((e) => e.amount)).toEqual([5000]);
    expect(b.vendors.vendors.map((v) => v.name)).toEqual(['Dorje']);
    expect(b.guidance.rules.length).toBe(1);
    expect(b.treks.treks[0].seatsLeft).toBe(9);
    expect(report.received).toBe(5);
    expect(report.sent).toBe(0);
  });

  it('end with both payments on both phones after each adds one', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const { t, b: bk } = setUpTrek(a);
    await a.sync(sheet);
    await b.sync(sheet); // both now share the trip and the booking

    tick();
    a.pay(5000, t, bk);
    tick();
    b.pay(7000, t, bk, at(1_800_100_000));
    await a.sync(sheet);
    await b.sync(sheet);
    await a.sync(sheet);

    expect(new Set(a.ledger.entries.map((e) => e.amount))).toEqual(new Set([5000, 7000]));
    expect(new Set(b.ledger.entries.map((e) => e.amount))).toEqual(new Set([5000, 7000]));
    expect(sheet.lines('Money').length).toBe(2);
    expect(a.ledger.balance).toBe(12000);
    expect(b.ledger.balance).toBe(12000);
  });

  it('give the right seats after two people book the same trip', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const { t } = setUpTrek(a, 10); // Asha already holds 1 seat: 9 left
    await a.sync(sheet);
    await b.sync(sheet);

    tick();
    a.bookings.confirm({ trekID: t.id, travellers: ['P', 'Q'], phone: '2', trekStore: a.treks }); // a: 7 left
    b.bookings.confirm({ trekID: t.id, travellers: ['R'], phone: '3', trekStore: b.treks }); // b: 8 left
    await a.sync(sheet);
    await b.sync(sheet);
    await a.sync(sheet);

    expect(a.treks.treks[0].seatsLeft).toBe(6);
    expect(b.treks.treks[0].seatsLeft).toBe(6);
    expect(a.bookings.bookings.length).toBe(3);
  });

  it('report the last seat taken twice to whoever syncs second', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const t = { ...trek('Kuari Pass', 2), seatCapacity: 2 };
    a.treks.upsert(t);
    await a.sync(sheet);
    await b.sync(sheet);
    a.bookings.confirm({ trekID: t.id, travellers: ['P', 'Q'], phone: '2', trekStore: a.treks });
    b.bookings.confirm({ trekID: t.id, travellers: ['R', 'S'], phone: '3', trekStore: b.treks });
    await a.sync(sheet);
    const report = await b.sync(sheet);
    expect(report.overbooked).toEqual([{ trekID: t.id, trekName: 'Kuari Pass', by: 2 }]);
    expect(syncSummary(report)).toContain('overbooked by 2 seats');
    expect(b.treks.treks[0].seatsLeft).toBe(0);
    expect(b.bookings.bookings.length).toBe(2); // nothing is dropped; staff decide
  });

  it('let the later edit of one record win and reach the other phone', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    a.treks.upsert(trek());
    await a.sync(sheet);
    await b.sync(sheet);

    tick();
    a.treks.upsert({ ...a.treks.treks[0], name: 'Edited on A' });
    tick();
    b.treks.upsert({ ...b.treks.treks[0], name: 'Edited on B, later' });
    await a.sync(sheet);
    await b.sync(sheet);
    await a.sync(sheet);
    expect(a.treks.treks.map((x) => x.name)).toEqual(['Edited on B, later']);
    expect(b.treks.treks.map((x) => x.name)).toEqual(['Edited on B, later']);
  });

  it('carry a delete from one phone to the other', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const { t, b: bk } = setUpTrek(a);
    const e = a.pay(5000, t, bk);
    await a.sync(sheet);
    await b.sync(sheet);
    expect(b.ledger.entries.length).toBe(1);

    tick();
    a.ledger.remove(e.id);
    await a.sync(sheet);
    await b.sync(sheet);
    expect(b.ledger.entries).toEqual([]);
    expect(b.ledger.balance).toBe(0);
    expect(sheet.lines('Money').length).toBe(1); // the sheet keeps the tombstone, so late phones learn of it
  });

  it('flag the same payment typed on two phones, and let "keep all" silence it', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const { t, b: bk } = setUpTrek(a);
    await a.sync(sheet);
    await b.sync(sheet);
    a.pay(5000, t, bk);
    tick();
    b.pay(5000, t, bk);
    await a.sync(sheet);
    const report = await b.sync(sheet);
    expect(report.duplicates).toBe(1);
    expect(syncSummary(report)).toContain('1 possible duplicate payment to review');
    expect(b.ledger.entries.length).toBe(2); // flagged, never removed
    const dismissed = new Set(duplicateGroups(b.ledger.entries).map((g) => g.id));
    expect((await b.sync(sheet, dismissed)).duplicates).toBe(0);
  });

  it('keep both when someone syncs between my read and my write, with no retry needed', async () => {
    const sheet = new FakeSheet(), a = new Phone(), b = new Phone();
    const { t, b: bk } = setUpTrek(a);
    await a.sync(sheet);
    await b.sync(sheet);
    const manager = sheet.addPerson('Meera Paul', 'Manager');
    const theirs = makeEntry({
      date: FUTURE, kind: 'Money in', amount: 9999, bookingID: bk.id, customerName: 'Asha Rao',
      shares: [{ trekID: t.id, trekName: t.name, amount: 9999 }], updatedAt: at(2_000_000), createdBy: manager.id,
    });
    sheet.sneak = () => { // another phone's push lands after my pull
      const r = sheet.env.call({
        action: 'push', session: manager.session,
        tables: buildTables({ ...emptyData(), ledger: [theirs] }).filter((x) => x.rows.length > 0),
      });
      expect(r.ok).toBe(true);
    };
    b.pay(5000, t, bk);
    const report = await b.sync(sheet); // one pull, one push: the sheet merges record by record
    expect(sheet.lines('Money').length).toBe(2);
    expect(sheet.actions.slice(-2)).toEqual(['pull', 'push']);
    expect(report.sent).toBe(1);
    await b.sync(sheet);
    expect(new Set(b.ledger.entries.map((e) => e.amount))).toEqual(new Set([5000, 9999]));
  });

  it('only send the records that are not in the sheet yet', async () => {
    const sheet = new FakeSheet(), a = new Phone();
    const { t, b: bk } = setUpTrek(a);
    a.pay(5000, t, bk);
    const first = await a.sync(sheet);
    expect(first.sent).toBe(3); // trek, booking, payment
    a.pay(700, t, bk, at(1_800_100_000));
    const second = await a.sync(sheet);
    expect(second.sent).toBe(1);
    expect(second.written).toEqual({ Money: 1 });
  });

  it('stop on a row the app cannot read and change nothing', async () => {
    const sheet = new FakeSheet(), a = new Phone();
    const { t, b: bk } = setUpTrek(a);
    a.pay(5000, t, bk);
    sheet.putRaw('Money', ['{"id":"not-a-uuid","future":true}']);
    const before = a.ledger.entries;
    const e = await failure(a.sync(sheet));
    expect(codeOf(e)).toBe('unreadableRows');
    expect((e as Error).message).toContain('1 row this app can');
    expect(a.ledger.entries).toEqual(before);
    expect(sheet.actions).not.toContain('push'); // nothing pushed
  });

  it('do not let a reinstalled phone with only the starter trek overwrite the sheet', async () => {
    const sheet = new FakeSheet(), a = new Phone(seedTreks);
    a.treks.upsert({ ...a.treks.treks[0], name: 'Gorkhey (real details)', pricePerPerson: 9500 });
    await a.sync(sheet);

    const fresh = new Phone(seedTreks); // reinstall: starter trek only
    await fresh.sync(sheet);
    expect(fresh.treks.treks.map((x) => x.name)).toEqual(['Gorkhey (real details)']);
    await a.sync(sheet);
    expect(a.treks.treks.map((x) => x.name)).toEqual(['Gorkhey (real details)']);
  });

  it('have nothing to sync when both are empty', async () => {
    const sheet = new FakeSheet(), a = new Phone();
    expect(codeOf(await failure(a.sync(sheet)))).toBe('nothingToSync');
  });

  it('say so when already in step', async () => {
    const sheet = new FakeSheet(), a = new Phone();
    a.treks.upsert(trek());
    await a.sync(sheet);
    const again = await a.sync(sheet);
    expect(again.received).toBe(0);
    expect(again.sent).toBe(0);
    expect(syncSummary(again)).toBe('Everything was already in step.');
  });

  it('do not show a booking and payment made this session as changes on the next sync', async () => {
    const sheet = new FakeSheet(), a = new Phone();
    const { t, b: bk } = setUpTrek(a);
    a.pay(5000, t, bk);
    await a.sync(sheet);
    const again = await a.sync(sheet);
    expect(syncSummary(again)).toBe('Everything was already in step.');
  });

  it('do not show records with fractional-second dates as changes (regression)', async () => {
    // A phone (or the iPhone app) can hold a date with a fraction of a second. Saved to the second, it must still equal itself.
    const sheet = new FakeSheet(), a = new Phone();
    const { t, b: bk } = setUpTrek(a);
    const e = a.pay(5000, t, bk);
    a.ledger.replaceAll([{ ...e, createdAt: '2026-11-03T05:01:00.789Z' }]);
    await a.sync(sheet);
    const again = await a.sync(sheet);
    expect(syncSummary(again)).toBe('Everything was already in step.');
  });

  it('read a sync report in plain words', () => {
    const r: CloudSyncReport = { received: 3, sent: 2, duplicates: 2, overbooked: [], written: {}, refused: [], person: { id: 'X', name: 'Asha', role: 'Owner' }, directory: [] };
    expect(syncSummary(r)).toBe('Synced: took 3 new or changed from others, sent 2. 2 possible duplicate payments to review in Money.');
  });
});

