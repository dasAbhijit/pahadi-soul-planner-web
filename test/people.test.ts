import { FUTURE, FakeSheet, PASSWORD, Phone, ADDRESS, codeOf, failure, frozenClock, sec } from './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/core/account';
import { AppContainer } from '../src/core/app';
import { ledgerCsv, restoreBackup, snapshot, decodeBackup, encodeBackup } from '../src/core/backup';
import { decodeLine, parseBooking, parseEntry, parseTrek } from '../src/core/codec';
import { newId, type Id } from '../src/core/ids';
import { makeBooking, makeEntry, makeTrek, makeVendor, type LedgerEntry, type Trek } from '../src/core/models';
import { can, canEditBooking, canEditEntry, limitToRole, limitToWritable } from '../src/core/roles';
import { MemoryKV } from '../src/core/storage';
import { Actor } from '../src/core/syncrecord';
import { emptyData } from '../src/core/syncmerge';
import { buildTables, inviteText } from '../src/core/sheetsync';

let clock: ReturnType<typeof frozenClock>;
beforeEach(() => { clock = frozenClock(1_000_000); Actor.id = undefined; });
afterEach(() => { clock.restore(); Actor.id = undefined; });

const ME = 'AAAAAAAA-0000-4000-8000-00000000000A';
const YOU = 'BBBBBBBB-0000-4000-8000-00000000000B';

const trek = (name = 'Kuari Pass', seats = 10): Trek => makeTrek({ name, durationDays: 6, pricePerPerson: 14500, startDate: FUTURE, seatsLeft: seats, seatCapacity: seats });

function pay(p: Phone, t: Trek, bookingID: Id, amount = 5000, kind: 'Money in' | 'Money out' = 'Money in'): LedgerEntry {
  return p.ledger.add(makeEntry({
    date: sec(1_800_000_000), kind, amount, mode: 'UPI', ...(kind === 'Money in' ? { bookingID, customerName: 'Asha' } : { vendorID: newId(), vendorName: 'Dorje' }),
    shares: [{ trekID: t.id, trekName: t.name, amount }],
  }));
}

// ------------------------------------------------------------------ Who recorded what

describe('authorship', () => {
  it('stamps new records with the signed-in person as author and last editor', () => {
    Actor.id = ME;
    const p = new Phone();
    p.treks.upsert(trek());
    const t = p.treks.treks[0];
    expect([t.createdBy, t.updatedBy]).toEqual([ME, ME]);
    const b = p.bookings.confirm({ trekID: t.id, travellers: ['Asha Rao'], phone: '1', trekStore: p.treks });
    expect([b.createdBy, b.updatedBy]).toEqual([ME, ME]);
    const e = pay(p, t, b.id);
    expect([e.createdBy, e.updatedBy]).toEqual([ME, ME]);
    p.vendors.upsert(makeVendor({ name: 'Dorje' }));
    expect(p.vendors.vendors[0].createdBy).toBe(ME);
    p.guidance.add('Mention the pickup point');
    expect([p.guidance.rules[0].createdBy, p.guidance.rules[0].updatedBy]).toEqual([ME, ME]);
  });

  it('keeps the author when someone else edits, and records who edited', () => {
    const p = new Phone();
    Actor.id = ME;
    p.treks.upsert(trek());
    Actor.id = YOU;
    clock.tick();
    p.treks.upsert({ ...p.treks.treks[0], name: 'Renamed' });
    const t = p.treks.treks[0];
    expect([t.name, t.createdBy, t.updatedBy]).toEqual(['Renamed', ME, YOU]);
  });

  it('does not let an edit pass off someone else as the author, or invent one for an old record', () => {
    const p = new Phone();
    p.treks.upsert({ ...trek(), createdBy: YOU }); // no one signed in: left as given
    Actor.id = ME;
    clock.tick();
    p.treks.upsert({ ...p.treks.treks[0], name: 'Edit by me' });
    expect(p.treks.treks[0].createdBy).toBe(YOU); // an existing record keeps its author

    Actor.id = undefined;
    const old = new Phone();
    old.treks.upsert(trek('Old trek'));
    expect(old.treks.treks[0].createdBy).toBeUndefined();
    Actor.id = ME;
    clock.tick();
    old.treks.upsert({ ...old.treks.treks[0], name: 'Old trek edited' });
    const t = old.treks.treks[0];
    expect([t.createdBy, t.updatedBy]).toEqual([undefined, ME]); // records from before sign-in stay without an author
  });

  it('marks who deleted a record, and who cancelled a booking', () => {
    const p = new Phone();
    Actor.id = ME;
    p.treks.upsert(trek());
    const t = p.treks.treks[0];
    const b = p.bookings.confirm({ trekID: t.id, travellers: ['Asha'], phone: '1', trekStore: p.treks });
    const e = pay(p, t, b.id);
    Actor.id = YOU;
    clock.tick();
    p.bookings.cancel(b.id, p.treks);
    expect(p.bookings.bookings[0].updatedBy).toBe(YOU);
    expect(p.bookings.bookings[0].createdBy).toBe(ME);
    p.ledger.remove(e.id);
    const tomb = p.ledger.syncRecords.find((x) => x.id === e.id)!;
    expect([tomb.deletedAt !== undefined, tomb.updatedBy, tomb.createdBy]).toEqual([true, YOU, ME]);
  });

  it('copies a trek without copying who made it', () => {
    const p = new Phone();
    Actor.id = ME;
    p.treks.upsert(trek());
    Actor.id = YOU;
    const copy = p.treks.duplicate(p.treks.treks[0].id, FUTURE)!;
    expect([copy.createdBy, copy.updatedBy]).toEqual([YOU, YOU]);
  });

  it('is not added when nobody is signed in (nothing changes for the old behaviour)', () => {
    const p = new Phone();
    p.treks.upsert(trek());
    expect(p.treks.treks[0].createdBy).toBeUndefined();
    expect(JSON.stringify(p.treks.treks[0])).not.toContain('By');
  });

  it('is read and written with the record, and old lines without it still load', () => {
    const p = new Phone();
    Actor.id = ME;
    p.treks.upsert(trek());
    const line = JSON.stringify(p.treks.treks[0]);
    const back = decodeLine(parseTrek, line)!;
    expect([back.createdBy, back.updatedBy]).toEqual([ME, ME]);
    const lower = decodeLine(parseTrek, line.replace(ME, ME.toLowerCase()).replace(ME, ME.toLowerCase()))!;
    expect(lower.createdBy).toBe(ME); // ids are read in upper case, like every other id
    expect(decodeLine(parseTrek, '{"id":"11111111-1111-1111-1111-111111111111","name":"x"}')!.createdBy).toBeUndefined();
    expect(decodeLine(parseBooking, '{"id":"11111111-1111-1111-1111-111111111111","trekID":"11111111-1111-1111-1111-111111111111","travellers":["A"],"phone":"1","createdBy":"nope"}')).toBeNull();
  });

  it('travels in a backup and shows in the CSV as "Recorded by"', () => {
    const p = new Phone();
    Actor.id = ME;
    p.treks.upsert(trek());
    const t = p.treks.treks[0];
    const b = p.bookings.confirm({ trekID: t.id, travellers: ['Asha'], phone: '1', trekStore: p.treks });
    pay(p, t, b.id);
    const parts = { treks: p.treks, bookings: p.bookings, ledger: p.ledger, vendors: p.vendors, guidance: p.guidance, settings: p.settings };
    const restored = decodeBackup(encodeBackup(snapshot(parts)));
    expect(restored.ledger[0].createdBy).toBe(ME);
    const csv = ledgerCsv(p.ledger.entries, (id) => (id === ME ? 'Meera Paul' : undefined)).split('\r\n');
    expect(csv[0].endsWith(',Recorded by')).toBe(true);
    expect(csv[1].endsWith(',Meera Paul')).toBe(true);
    const fresh = new Phone();
    restoreBackup(restored, { treks: fresh.treks, bookings: fresh.bookings, ledger: fresh.ledger, vendors: fresh.vendors, guidance: fresh.guidance, settings: fresh.settings });
    expect(fresh.ledger.entries[0].createdBy).toBe(ME);
  });
});

// ------------------------------------------------------------------ Roles

describe('roles', () => {
  it('Owner can do everything', () => {
    for (const c of ['seeMoneyOut', 'seeVendorRates', 'editTreks', 'cancelBooking', 'editAnyRecord', 'editVendors', 'editRules', 'exportData', 'editPrompt', 'restoreBackup', 'manageSheet', 'managePeople'] as const) {
      expect(can('Owner', c), c).toBe(true);
    }
  });

  it('Manager can run the business but not the app', () => {
    for (const c of ['seeMoneyOut', 'seeVendorRates', 'editTreks', 'cancelBooking', 'editAnyRecord', 'editVendors', 'editRules', 'exportData'] as const) expect(can('Manager', c), c).toBe(true);
    for (const c of ['editPrompt', 'restoreBackup', 'manageSheet', 'managePeople'] as const) expect(can('Manager', c), c).toBe(false);
  });

  it('Staff can do none of the restricted things, and nobody signed in can do nothing', () => {
    for (const c of ['seeMoneyOut', 'seeVendorRates', 'editTreks', 'cancelBooking', 'editAnyRecord', 'editVendors', 'editRules', 'exportData', 'editPrompt', 'restoreBackup', 'manageSheet', 'managePeople'] as const) {
      expect(can('Staff', c), c).toBe(false);
      expect(can(undefined, c), c).toBe(false);
    }
  });

  it('lets Staff change only their own live bookings and their own payments received', () => {
    const mine = makeBooking({ trekID: newId(), travellers: ['A'], phone: '1', createdBy: ME });
    const theirs = { ...mine, createdBy: YOU };
    const cancelled = { ...mine, cancelledAt: mine.createdAt };
    expect([canEditBooking('Staff', ME, mine), canEditBooking('Staff', ME, theirs), canEditBooking('Staff', ME, cancelled)]).toEqual([true, false, false]);
    expect([canEditBooking('Manager', ME, theirs), canEditBooking('Owner', ME, cancelled)]).toEqual([true, true]);
    const inEntry = makeEntry({ date: FUTURE, kind: 'Money in', amount: 5, createdBy: ME });
    const outEntry = makeEntry({ date: FUTURE, kind: 'Money out', amount: 5, createdBy: ME });
    expect([canEditEntry('Staff', ME, inEntry), canEditEntry('Staff', ME, { ...inEntry, createdBy: YOU }), canEditEntry('Staff', ME, outEntry)]).toEqual([true, false, false]);
    expect(canEditEntry('Manager', ME, outEntry)).toBe(true);
  });

  it('strips money out, vendor rates and agreed amounts for Staff only', () => {
    const v = makeVendor({ name: 'Dorje', phone: '98', rate: 900, agreements: [{ trekID: newId(), trekName: 'K', amount: 4000 }] });
    const data = { ...emptyData(), vendors: [v], ledger: [makeEntry({ date: FUTURE, kind: 'Money in', amount: 1 }), makeEntry({ date: FUTURE, kind: 'Money out', amount: 2 })] };
    const staff = limitToRole(data, 'Staff');
    expect(staff.ledger.map((e) => e.kind)).toEqual(['Money in']);
    expect([staff.vendors[0].name, staff.vendors[0].phone, staff.vendors[0].rate, staff.vendors[0].agreements]).toEqual(['Dorje', '98', undefined, []]);
    expect(limitToRole(data, 'Manager')).toBe(data);
  });

  it('sends nothing from Staff but their own new bookings and payments received', () => {
    const data = {
      treks: [makeTrek({ name: 'x' })], vendors: [makeVendor({ name: 'v' })], guidance: [],
      bookings: [makeBooking({ trekID: newId(), travellers: ['A'], phone: '1', createdBy: ME }), makeBooking({ trekID: newId(), travellers: ['B'], phone: '1', createdBy: YOU })],
      ledger: [makeEntry({ date: FUTURE, kind: 'Money in', amount: 1, createdBy: ME }), makeEntry({ date: FUTURE, kind: 'Money out', amount: 2, createdBy: ME })],
    };
    const out = limitToWritable(data, 'Staff', ME);
    expect([out.treks.length, out.vendors.length, out.bookings.length, out.ledger.length]).toEqual([0, 0, 1, 1]);
    expect(limitToWritable(data, 'Manager', ME)).toBe(data);
  });
});

// ------------------------------------------------------------------ The account on this phone

describe('account', () => {
  const reply = { session: 'S3SS10N', person: { id: ME, name: 'Meera Paul', role: 'Manager' as const }, directory: [{ id: ME, name: 'Meera Paul' }, { id: YOU, name: 'Rohit Sharma' }], spreadsheet: 'Pahadi Soul Planner App' };

  it('starts signed out, with nobody as the author', () => {
    const a = new AccountStore(new MemoryKV());
    expect([a.signedIn, a.person, a.role, a.session]).toEqual([false, undefined, undefined, null]);
    expect(Actor.id).toBeUndefined();
  });

  it('signs in, remembers across a restart, and sets the author', () => {
    const kv = new MemoryKV();
    const a = new AccountStore(kv);
    a.signIn(reply, sec(5));
    expect([a.signedIn, a.role, a.myId, a.sheetName, a.signedInAt]).toEqual([true, 'Manager', ME, 'Pahadi Soul Planner App', sec(5)]);
    expect(Actor.id).toBe(ME);
    Actor.id = undefined;
    const again = new AccountStore(kv);
    expect([again.signedIn, again.person?.name]).toEqual([true, 'Meera Paul']);
    expect(Actor.id).toBe(ME);
  });

  it('keeps the session code apart from the other details', () => {
    const kv = new MemoryKV();
    new AccountStore(kv).signIn(reply, sec(5));
    expect(kv.get('pahadi.secret.session')).toBe('S3SS10N');
    expect(kv.get('pahadi.account')).not.toContain('S3SS10N');
  });

  it('names people from the directory, by full and first name', () => {
    const a = new AccountStore(new MemoryKV());
    a.signIn(reply, sec(5));
    expect([a.nameOf(YOU), a.firstNameOf(YOU), a.nameOf(undefined), a.nameOf('CCCCCCCC-0000-4000-8000-000000000000')]).toEqual(['Rohit Sharma', 'Rohit', undefined, undefined]);
  });

  it('takes a new role and new names from the sheet', () => {
    const a = new AccountStore(new MemoryKV());
    a.signIn(reply, sec(5));
    a.refresh({ ...reply.person, role: 'Staff' }, [{ id: ME, name: 'Meera Paul' }]);
    expect([a.role, a.directory.length]).toEqual(['Staff', 1]);
  });

  it('signs out and remembers why when the sheet did it', () => {
    const kv = new MemoryKV();
    const a = new AccountStore(kv);
    a.signIn(reply, sec(5));
    a.end('removed');
    expect([a.signedIn, a.session, a.ended, Actor.id]).toEqual([false, null, 'removed', undefined]);
    expect(new AccountStore(kv).ended).toBe('removed');
    a.clearEnded();
    expect(a.ended).toBeUndefined();
    a.signIn(reply, sec(6));
    a.end();
    expect(a.ended).toBeUndefined();
  });

  it('treats a saved person with no session code as signed out', () => {
    const kv = new MemoryKV();
    new AccountStore(kv).signIn(reply, sec(5));
    kv.remove('pahadi.secret.session');
    expect(new AccountStore(kv).signedIn).toBe(false);
  });
});

// ------------------------------------------------------------------ The app with a real sheet script

function appFor(sheet: FakeSheet) {
  const app = new AppContainer(new MemoryKV(), sheet.client);
  return app;
}

describe('app flows', () => {
  it('signs in with a name that is not case sensitive and remembers the sheet address', async () => {
    const sheet = new FakeSheet();
    const other = appFor(sheet);
    await other.signIn(ADDRESS, 'asha rao', PASSWORD);
    expect([other.account.signedIn, other.account.role, other.account.person?.name]).toEqual([true, 'Owner', 'Asha Rao']);
    expect(other.settings.syncUrl).toBe(ADDRESS);
    expect(Actor.id).toBe(sheet.owner.id);
  });

  it('refuses a wrong password with the tries left and stays signed out', async () => {
    const sheet = new FakeSheet();
    const app = appFor(sheet);
    const e = await failure(app.signIn(ADDRESS, 'Asha Rao', 'wrong-password'));
    expect([codeOf(e), (e as Error).message]).toEqual(['badLogin', 'Wrong name or password. 4 tries left.']);
    expect(app.account.signedIn).toBe(false);
  });

  it('joins with an invite and syncs what the team has entered', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    owner.treks.upsert(trek());
    await owner.sync();

    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Tashi Sherpa', role: 'Staff' });
    const staff = appFor(sheet);
    await staff.join(ADDRESS, inv.code, 'tashi-password-1');
    expect(staff.account.role).toBe('Staff');
    const report = await staff.sync();
    expect(staff.treks.treks.map((t) => t.name)).toEqual(['Kuari Pass']);
    expect(report.received).toBe(1);
    expect(staff.account.nameOf(owner.account.myId)).toBe('Asha Rao');
    expect(inviteText(ADDRESS, inv.code)).toContain('PSP1.');
  });

  it('stamps Staff records with their name and the Owner sees them', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    const t = trek();
    owner.treks.upsert(t);
    await owner.sync();
    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Tashi Sherpa', role: 'Staff' });
    const staff = appFor(sheet);
    await staff.join(ADDRESS, inv.code, 'tashi-password-1');
    await staff.sync();
    const b = staff.bookings.confirm({ trekID: staff.treks.treks[0].id, travellers: ['Pooja'], phone: '1', trekStore: staff.treks });
    staff.ledger.add(makeEntry({ date: sec(1_800_000_000), kind: 'Money in', amount: 5000, bookingID: b.id, customerName: 'Pooja', shares: [{ trekID: t.id, trekName: t.name, amount: 5000 }] }));
    const report = await staff.sync();
    expect(report.sent).toBe(2);
    expect(report.refused).toEqual([]);

    await owner.sync();
    expect(owner.bookings.bookings[0].createdBy).toBe(staff.account.myId);
    expect(owner.ledger.entries[0].createdBy).toBe(staff.account.myId);
    expect(owner.account.nameOf(owner.ledger.entries[0].createdBy)).toBe('Tashi Sherpa');
  });

  it('never gives Staff money out or vendor rates, and clears them from a phone whose role became Staff', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    const t = trek();
    owner.treks.upsert(t);
    const bk = owner.bookings.confirm({ trekID: t.id, travellers: ['Pooja'], phone: '1', trekStore: owner.treks });
    owner.ledger.add(makeEntry({ date: sec(1_800_000_000), kind: 'Money in', amount: 5000, bookingID: bk.id, customerName: 'Pooja', shares: [{ trekID: t.id, trekName: t.name, amount: 5000 }] }));
    owner.ledger.add(makeEntry({ date: sec(1_800_000_000), kind: 'Money out', amount: 3000, vendorID: newId(), vendorName: 'Dorje', shares: [{ trekID: t.id, trekName: t.name, amount: 3000 }] }));
    owner.vendors.upsert(makeVendor({ name: 'Dorje', phone: '98', rate: 900, agreements: [{ trekID: t.id, trekName: t.name, amount: 4000 }] }));
    await owner.sync();

    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Meera Paul', role: 'Manager' });
    const meera = appFor(sheet);
    await meera.join(ADDRESS, inv.code, 'meera-password-1');
    await meera.sync();
    expect(meera.ledger.entries.length).toBe(2);
    expect(meera.vendors.vendors[0].rate).toBe(900);

    await sheet.client.setRole(ADDRESS, owner.account.session!, meera.account.myId!, 'Staff');
    await meera.sync();
    expect(meera.account.role).toBe('Staff');
    expect(meera.ledger.entries.map((e) => e.kind)).toEqual(['Money in']);
    expect([meera.vendors.vendors[0].name, meera.vendors.vendors[0].rate, meera.vendors.vendors[0].agreements]).toEqual(['Dorje', undefined, []]);
    expect(JSON.stringify([...(meera.kv as MemoryKV).map.values()])).not.toContain('"amount":3000');

    // The sheet itself still has everything.
    await owner.sync();
    expect(owner.ledger.entries.length).toBe(2);
    expect(owner.vendors.vendors[0].rate).toBe(900);
  });

  it('keeps a Staff phone from changing treks, even by a changed app', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    owner.treks.upsert(trek());
    await owner.sync();
    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Tashi Sherpa', role: 'Staff' });
    const staff = appFor(sheet);
    await staff.join(ADDRESS, inv.code, 'tashi-password-1');
    await staff.sync();
    clock.tick();
    staff.treks.upsert({ ...staff.treks.treks[0], name: 'Hacked' });
    const report = await staff.sync();
    expect(report.sent).toBe(0);
    expect(staff.treks.treks[0].name).toBe('Kuari Pass'); // the sheet's version wins back
    await owner.sync();
    expect(owner.treks.treks[0].name).toBe('Kuari Pass');
  });

  it('signs out: company data, rules, chat and the Gemini key leave the phone; the sheet address stays', async () => {
    const sheet = new FakeSheet();
    const app = appFor(sheet);
    await app.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    app.treks.upsert(trek());
    app.vendors.upsert(makeVendor({ name: 'Dorje' }));
    app.guidance.add('A rule');
    app.secrets.setGeminiKey('AIza-SECRET');
    app.settings.setSystemPrompt('My own prompt');
    await app.sync();
    await app.signOut();
    expect([app.account.signedIn, app.treks.treks.length, app.bookings.bookings.length, app.ledger.entries.length, app.vendors.vendors.length, app.guidance.rules.length]).toEqual([false, 0, 0, 0, 0, 0]);
    expect(app.secrets.geminiKey).toBeNull();
    expect(app.settings.syncUrl).toBe(ADDRESS);
    expect(app.settings.lastSyncAt).toBeUndefined();
    expect(app.settings.systemPrompt).not.toBe('My own prompt');
    expect(JSON.stringify([...(app.kv as MemoryKV).map.entries()])).not.toContain('AIza-SECRET');
    expect(Actor.id).toBeUndefined();
    // Signing out did not send deletions: the sheet still has everything.
    expect(sheet.lines('Treks').length).toBe(1);
    // A restart still finds the phone empty, not re-seeded with the placeholder trek.
    expect(new AppContainer((app.kv as MemoryKV), sheet.client).treks.treks.length).toBe(0);
  });

  it('clears the phone and says why when the sheet ends the session', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Rohit Sharma', role: 'Staff' });
    owner.treks.upsert(trek());
    await owner.sync();
    const rohit = appFor(sheet);
    await rohit.join(ADDRESS, inv.code, 'rohit-password-1');
    await rohit.sync();
    rohit.secrets.setGeminiKey('AIza-ROHIT');
    expect(rohit.treks.treks.length).toBe(1);

    await sheet.client.removePerson(ADDRESS, owner.account.session!, rohit.account.myId!);
    const e = await failure(rohit.sync());
    expect([codeOf(e), (e as { reason?: string }).reason]).toEqual(['sessionEnded', 'removed']);
    expect([rohit.account.signedIn, rohit.account.ended, rohit.treks.treks.length, rohit.secrets.geminiKey]).toEqual([false, 'removed', 0, null]);
  });

  it('explains a reset and an expired session the same way', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Rohit Sharma', role: 'Staff' });
    const rohit = appFor(sheet);
    await rohit.join(ADDRESS, inv.code, 'rohit-password-1');
    await sheet.client.resetSignIn(ADDRESS, owner.account.session!, rohit.account.myId!);
    expect(codeOf(await failure(rohit.sync()))).toBe('sessionEnded');
    expect(rohit.account.ended).toBe('reset');

    const asha2 = appFor(sheet);
    await asha2.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    sheet.env.advance(91 * 86400000);
    expect(codeOf(await failure(asha2.sync()))).toBe('sessionEnded');
    expect(asha2.account.ended).toBe('expired');
  });

  it('refuses to sync when nobody is signed in', async () => {
    const app = appFor(new FakeSheet());
    expect(codeOf(await failure(app.sync()))).toBe('notSignedIn');
  });

  it('drops the sync secret an earlier version kept', () => {
    const kv = new MemoryKV();
    kv.set('pahadi.secret.sync', 'OLD-SECRET');
    new AppContainer(kv);
    expect(kv.get('pahadi.secret.sync')).toBeNull();
  });

  it('reports changes the sheet would not accept instead of hiding them', async () => {
    const sheet = new FakeSheet();
    const owner = appFor(sheet);
    await owner.signIn(ADDRESS, 'Asha Rao', PASSWORD);
    const inv = await sheet.client.invite(ADDRESS, owner.account.session!, { name: 'Rohit Sharma', role: 'Staff' });
    owner.treks.upsert(trek());
    await owner.sync();
    const rohit = appFor(sheet);
    await rohit.join(ADDRESS, inv.code, 'rohit-password-1');
    await rohit.sync();
    // Push past the app's own checks, as a changed app could: the sheet still refuses.
    const forged = buildTables({ ...emptyData(), treks: [{ ...trek(), updatedAt: '2030-01-01T00:00:00Z', createdBy: rohit.account.myId }] });
    const r = sheet.env.call({ action: 'push', session: rohit.account.session!, tables: forged.filter((x) => x.rows.length > 0) }) as { accepted: { Treks: number }; rejected: { reason: string }[] };
    expect(r.accepted.Treks).toBe(0);
    expect(r.rejected[0].reason).toMatch(/cannot change treks/);
  });
});
