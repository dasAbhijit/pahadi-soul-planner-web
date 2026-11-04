import { attempt, codeOf, date, frozenClock, same, thrown } from './helpers';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors';
import { buildPrompt, DEFAULT_SYSTEM_PROMPT, MAX_VENDORS } from '../src/core/prompt';
import { DEFAULT_MODEL, GeminiError, makeStreamRequest, parseSSELine, shouldTryNextModel } from '../src/core/gemini';
import { formatForWhatsApp, whatsAppUrl } from '../src/core/whatsapp';
import {
  BookingStore, GuidanceStore, LedgerStore, MAX_AMOUNT, MAX_RULES, TrekStore, VendorStore, MAX_PARTY,
} from '../src/core/stores';
import {
  makeEntry, makeTrek, makeVendor, parseTags, trekTiming, MAX_TAGS, SCOPE_ALL,
  type EntryKind, type LedgerEntry, type LedgerFilter, type Trek, type Vendor,
} from '../src/core/models';
import { newId, type Id } from '../src/core/ids';
import { MemoryKV } from '../src/core/storage';
import { SettingsStore } from '../src/core/settings';
import {
  BACKUP_FORMAT, MAX_BACKUP_BYTES, backupFilename, decodeBackup, encodeBackup, ledgerCsv, restoreBackup, snapshot, type Backup,
} from '../src/core/backup';
import { grouped, rupees, signedRupees } from '../src/core/fmt';

/** The same rules the iPhone and Android apps' tests check, so the three apps behave alike. */

let clock: ReturnType<typeof frozenClock>;
beforeEach(() => { clock = frozenClock(); });
afterEach(() => clock.restore());

const noSeed = () => [] as Trek[];
const filter = (f: Partial<LedgerFilter> = {}): LedgerFilter => ({ scope: SCOPE_ALL, customer: '', ...f });

// ---- Catalogue and prompt

describe('catalogue and prompt', () => {
  it('classifies timing', () => {
    const now = new Date(2026, 10, 3);
    expect(trekTiming(makeTrek({ name: 'A', startDate: date(2026, 11, 3) }), now)).toBe('upcoming');
    expect(trekTiming(makeTrek({ name: 'B', startDate: date(2026, 11, 2) }), now)).toBe('past');
    expect(trekTiming(makeTrek({ name: 'C' }), now)).toBe('undated');
  });

  it('lists upcoming first, sorted, and marks sold out', () => {
    const now = new Date(2026, 10, 3);
    const treks = [
      makeTrek({ name: 'Later', durationDays: 3, startDate: date(2026, 12, 20), seatsLeft: 0 }),
      makeTrek({ name: 'Sooner', durationDays: 4, pricePerPerson: 9500, startDate: date(2026, 11, 20), seatsLeft: 5 }),
      makeTrek({ name: 'Old', startDate: date(2026, 5, 1) }),
      makeTrek({ name: 'Anytime' }),
    ];
    const p = buildPrompt({ basePrompt: 'BASE', treks, now });
    expect(p.startsWith('BASE')).toBe(true);
    const sooner = p.indexOf('- Sooner'), later = p.indexOf('- Later'), anytime = p.indexOf('- Anytime'), old = p.indexOf('- Old');
    expect(sooner < later && later < anytime && anytime < old).toBe(true);
    expect(p).toContain('Seats left: 5');
    expect(p).toContain('SOLD OUT');
    expect(p).toContain('Rs 9500 per person');
    expect(p).toContain('20 Nov 2026 to 23 Nov 2026');
  });

  it('still builds with an empty catalogue', () => {
    expect(buildPrompt({ basePrompt: 'X', treks: [], now: new Date(2026, 10, 3) })).toContain('None scheduled right now.');
  });

  it('includes guidance and the learning instruction', () => {
    const now = new Date(2026, 10, 3);
    const p = buildPrompt({ basePrompt: 'BASE', treks: [], guidance: ['Be brief.', 'Mention pickup.'], now });
    expect(p).toContain('- Be brief.\n- Mention pickup.');
    expect(p).toContain('propose_guidance_rule');
    expect(p.indexOf('STAFF GUIDANCE')).toBeLessThan(p.indexOf('TREK CATALOGUE'));
    expect(buildPrompt({ basePrompt: 'BASE', treks: [], now })).not.toContain('STAFF GUIDANCE');
  });

  it('puts the client brief in the prompt and caps it', () => {
    const now = new Date(2026, 10, 3);
    const p = buildPrompt({ basePrompt: 'B', treks: [], clientBrief: '  2 adults, first trek  ', now });
    expect(p).toContain('CURRENT CLIENT BRIEF');
    expect(p).toContain('2 adults, first trek');
    expect(buildPrompt({ basePrompt: 'B', treks: [], clientBrief: '   ', now })).not.toContain('CLIENT BRIEF');
    expect(buildPrompt({ basePrompt: 'B', treks: [], clientBrief: 'x'.repeat(900), now })).not.toContain('x'.repeat(501));
  });

  it('keeps the no-booking rule in the default prompt', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('You cannot take, hold or confirm bookings');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Pahadi Soul Travels');
  });

  it('lists vendors without contact details or payments', () => {
    const v = makeVendor({
      name: 'Dorje', service: 'Guide', phone: '98300 11111', rate: 1500, rateUnit: 'per day', tags: ['darjeeling', 'winter'],
      notes: 'Speaks Hindi and Nepali', agreements: [{ trekID: newId(), trekName: 'T', amount: 7777 }],
    });
    const now = new Date(2026, 10, 3);
    const p = buildPrompt({ basePrompt: 'BASE', treks: [], vendors: [v], now });
    expect(p).toContain('# VENDORS');
    expect(p).toContain('- Dorje | Service: Guide | Rate: Rs 1500 per day | Tags: darjeeling, winter');
    expect(p).toContain('Speaks Hindi');
    expect(p).not.toContain('98300 11111'); // phone stays on the device
    expect(p).not.toContain('7777'); // agreed amounts stay on the device
    expect(p).toContain('Never invent a vendor');
    expect(buildPrompt({ basePrompt: 'BASE', treks: [], now })).not.toContain('VENDORS');
    const many = Array.from({ length: 60 }, (_, i) => makeVendor({ name: `V${i}` }));
    const capped = buildPrompt({ basePrompt: 'B', treks: [], vendors: many, now });
    expect(capped.split('\n- V').length - 1).toBe(MAX_VENDORS);
  });
});

// ---- Gemini

describe('gemini', () => {
  it('parses a streamed reply', () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello "},{"text":"there"}],"role":"model"}}]}';
    expect(parseSSELine(line)).toEqual([{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }]);
    expect(parseSSELine('event: ping')).toEqual([]);
    expect(parseSSELine('data: {"candidates":[{"finishReason":"STOP"}]}')).toEqual([]);
    expect(parseSSELine('data: not json')).toEqual([]);
  });

  it('parses a guidance proposal and ignores other calls', () => {
    const call = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"propose_guidance_rule","args":{"rule":" Always mention the pickup point. "}}}]}}]}';
    expect(parseSSELine(call)).toEqual([{ type: 'guidance', rule: 'Always mention the pickup point.' }]);
    const other = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"something_else","args":{"rule":"x"}}}]}}]}';
    expect(parseSSELine(other)).toEqual([]);
    const blank = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"propose_guidance_rule","args":{"rule":"  "}}}]}}]}';
    expect(parseSSELine(blank)).toEqual([]);
  });

  it('keeps the key out of the URL and rejects a bad model name', () => {
    const req = makeStreamRequest('SECRET', 'gemini-2.5-flash', 'sys', [{ role: 'user', text: 'hi' }]);
    expect(req.headers['x-goog-api-key']).toBe('SECRET');
    expect(req.url).not.toContain('SECRET');
    expect(req.url).toContain(':streamGenerateContent');
    expect(req.body).toContain('systemInstruction');
    expect(req.body).toContain('propose_guidance_rule');
    expect(thrown(() => makeStreamRequest('k', '../evil?x=1', '', []))).toBeInstanceOf(GeminiError);
  });

  it('decides when to try the next model', () => {
    expect(shouldTryNextModel(new GeminiError('http', 'busy', 503))).toBe(true);
    expect(shouldTryNextModel(new GeminiError('http', 'retired', 404))).toBe(true);
    expect(shouldTryNextModel(new GeminiError('timeout', 'slow'))).toBe(true);
    expect(shouldTryNextModel(new GeminiError('http', 'bad request', 400))).toBe(false);
    expect(shouldTryNextModel(new GeminiError('http', 'bad key', 403))).toBe(false);
    expect(DEFAULT_MODEL).toBe('gemini-flash-latest');
  });

  it('formats a reply for WhatsApp', () => {
    const md = '### Gorkhey\n**Dates:** 20 Nov\n* Easy *first-timer* friendly\n- Pickup at [Siliguri](https://example.com)\n\n\n\nBook soon';
    expect(formatForWhatsApp(md)).toBe('*Gorkhey*\n*Dates:* 20 Nov\n• Easy _first-timer_ friendly\n• Pickup at Siliguri (https://example.com)\n\nBook soon');
    expect(whatsAppUrl('Hi & bye\nline two')).toBe('https://wa.me/?text=Hi%20%26%20bye%0Aline%20two');
  });
});

// ---- Treks and guidance

describe('treks and guidance', () => {
  it('adjusts seats and duplicates a trek', () => {
    const store = new TrekStore(new MemoryKV(), noSeed);
    const t = makeTrek({ name: 'Gorkhey', durationDays: 4, pricePerPerson: 9500, startDate: date(2026, 11, 20), seatsLeft: 1, notes: 'n' });
    store.upsert(t);
    expect(store.adjustSeats(t.id, -1)).toBe(0);
    expect(store.adjustSeats(t.id, -1)).toBe(0); // floor at zero
    expect(store.adjustSeats(t.id, 3)).toBe(3);
    const undated = makeTrek({ name: 'Anytime' });
    store.upsert(undated);
    expect(store.adjustSeats(undated.id, 1)).toBeNull(); // seats not tracked

    const copy = store.duplicate(t.id, date(2027, 1, 10))!;
    expect(copy.id).not.toBe(t.id);
    expect(copy.pricePerPerson).toBe(9500);
    expect(copy.notes).toBe('n');
    expect(copy.seatsLeft).toBeUndefined();
    expect(copy.startDate).toBe(date(2027, 1, 10));
    expect(store.treks.length).toBe(3);
  });

  it('persists and reloads', () => {
    const kv = new MemoryKV();
    const store = new TrekStore(kv, noSeed);
    const t = makeTrek({ name: 'Kedarkantha', startDate: date(2026, 12, 25) });
    store.upsert(t);
    store.upsert({ ...t, seatsLeft: 3 });
    expect(store.treks.length).toBe(1);
    const reloaded = new TrekStore(kv, noSeed);
    expect(reloaded.treks[0].seatsLeft).toBe(3);
    reloaded.delete([t.id]);
    expect(new TrekStore(kv, noSeed).treks).toEqual([]);
  });

  it('seeds a placeholder trek on first launch', () => {
    expect(new TrekStore(new MemoryKV()).treks.map((t) => t.name)).toEqual(['Gorkhey – Samanden']);
  });

  it('keeps rules, rejects bad ones, and undoes changes', () => {
    const kv = new MemoryKV();
    const store = new GuidanceStore(kv);
    const rule = store.add('  Mention the pickup point.  ');
    expect(rule.text).toBe('Mention the pickup point.');
    expect(codeOf(thrown(() => store.add('mention the PICKUP point.')))).toBe('duplicate');
    expect(codeOf(thrown(() => store.add('   ')))).toBe('empty');
    expect(codeOf(thrown(() => store.add('x'.repeat(281))))).toBe('tooLong');
    store.update(rule.id, 'Always give the pickup point.');
    store.remove(rule.id);
    expect(store.rules).toEqual([]);
    store.undo();
    expect(store.rules[0].text).toBe('Always give the pickup point.');
    expect(new GuidanceStore(kv).rules.length).toBe(1); // persisted
    store.undo(); store.undo();
    expect(store.rules).toEqual([]);
    expect(store.canUndo).toBe(false);
  });

  it('limits the number of rules', () => {
    const store = new GuidanceStore(new MemoryKV());
    for (let i = 0; i < MAX_RULES; i++) store.add(`rule ${i}`);
    expect(codeOf(thrown(() => store.add('one too many')))).toBe('limitReached');
  });
});

// ---- Bookings

const stores = () => ({ treks: new TrekStore(new MemoryKV(), noSeed), bookings: new BookingStore(new MemoryKV()), ledger: new LedgerStore(new MemoryKV()) });

describe('bookings', () => {
  it('takes seats on confirm and gives them back on cancel', () => {
    const bkv = new MemoryKV();
    const treks = new TrekStore(new MemoryKV(), noSeed);
    const bookings = new BookingStore(bkv);
    const now = new Date(2026, 10, 3);
    const trek = makeTrek({ name: 'Gorkhey', startDate: date(2026, 11, 20), seatsLeft: 6 });
    treks.upsert(trek);
    const b = bookings.confirm({ trekID: trek.id, travellers: [' Asha ', 'Ravi'], phone: ' 98300 00000 ', payment: 'Part paid', amountReceived: 5000, trekStore: treks, now });
    expect(b.travellers).toEqual(['Asha', 'Ravi']);
    expect(b.travellers.length).toBe(2);
    expect(b.phone).toBe('98300 00000');
    expect(treks.treks[0].seatsLeft).toBe(4);
    expect(bookings.bookingsFor(trek.id).length).toBe(1);
    expect(new BookingStore(bkv).bookings.length).toBe(1); // persisted

    bookings.cancel(b.id, treks);
    expect(treks.treks[0].seatsLeft).toBe(6);
    expect(bookings.bookingsFor(trek.id)).toEqual([]); // no longer live
    expect(bookings.bookingsFor(trek.id, true).length).toBe(1); // kept for refunds
    expect(new BookingStore(bkv).bookings[0].cancelledAt).toBeTruthy();
    bookings.cancel(b.id, treks); // twice gives no extra seats
    expect(treks.treks[0].seatsLeft).toBe(6);
  });

  it('rejects bad requests without side effects', () => {
    const { treks, bookings } = stores();
    const now = new Date(2026, 10, 3);
    const low = makeTrek({ name: 'Low', startDate: date(2026, 11, 20), seatsLeft: 1 });
    const past = makeTrek({ name: 'Past', startDate: date(2026, 5, 1), seatsLeft: 5 });
    const anytime = makeTrek({ name: 'Anytime' });
    [low, past, anytime].forEach((t) => treks.upsert(t));

    const tryBook = (id: Id, names: string[]) => attempt(() => bookings.confirm({ trekID: id, travellers: names, phone: '', trekStore: treks, now })) as AppError | null;
    const full = tryBook(low.id, ['A', 'B'])!;
    expect(full.code).toBe('notEnoughSeats');
    expect(full.info.left).toBe(1);
    expect(full.message).toBe('Only 1 seat left.');
    expect(tryBook(past.id, ['A'])!.code).toBe('trekNotUpcoming');
    expect(tryBook(low.id, ['A', ' '])!.code).toBe('missingName');
    expect(tryBook(low.id, [])!.code).toBe('noTravellers');
    expect(tryBook(low.id, Array.from({ length: MAX_PARTY + 1 }, (_, i) => `T${i}`))!.code).toBe('tooManyTravellers');
    expect(tryBook(newId(), ['A'])!.code).toBe('trekNotFound');
    expect(bookings.bookings).toEqual([]);
    expect(treks.trek(low.id)?.seatsLeft).toBe(1);

    expect(tryBook(anytime.id, ['A', 'B'])).toBeNull(); // undated: allowed, seats not tracked
    expect(treks.trek(anytime.id)?.seatsLeft).toBeUndefined();
    expect(tryBook(low.id, ['Last seat'])).toBeNull(); // exactly fills the trek
    expect(treks.trek(low.id)?.seatsLeft).toBe(0);
    const soldOut = tryBook(low.id, ['Too late'])!;
    expect(soldOut.code).toBe('notEnoughSeats');
    expect(soldOut.message).toBe('This trek is sold out.');
  });

  it('records the payment in the ledger and keeps refunds linked after a cancel', () => {
    const { treks, bookings, ledger } = stores();
    const now = new Date(2026, 10, 3);
    const trek = makeTrek({ name: 'Gorkhey', pricePerPerson: 9500, startDate: date(2026, 11, 20), seatsLeft: 6 });
    treks.upsert(trek);
    const b = bookings.confirm({ trekID: trek.id, travellers: ['Asha', 'Ravi'], phone: '', amountReceived: 5000, trekStore: treks, ledger, now });
    expect(ledger.entries.length).toBe(1);
    expect(ledger.receivedForTrek(trek.id)).toBe(5000);
    expect(ledger.entries[0].customerName).toBe('Asha');
    expect(ledger.entries[0].bookingID).toBe(b.id);
    expect(b.payment).toBe('Part paid');
    const s = ledger.paymentSummary(b, trek);
    expect(s.due).toBe(19000);
    expect(s.balance).toBe(14000);

    ledger.add(credit(trek.id, 14000, b.id));
    expect(ledger.paymentSummary(b, trek).status).toBe('Paid');

    bookings.cancel(b.id, treks); // the client pulls out
    expect(bookings.booking(b.id)!.cancelledAt).toBeTruthy();
    ledger.add(makeEntry({ date: toInst(now), kind: 'Money out', amount: 15000, note: 'Refund', bookingID: b.id, customerName: 'Asha', shares: [{ trekID: trek.id, trekName: 'Gorkhey', amount: 15000 }] }));
    expect(ledger.netReceivedForBooking(b.id)).toBe(4000);
    expect(ledger.entries.length).toBe(3);
    expect(ledger.balance).toBe(4000);
  });

  it('blocks a booking with a bad payment amount without side effects', () => {
    const { treks, bookings, ledger } = stores();
    const trek = makeTrek({ name: 'G', startDate: date(2026, 11, 20), seatsLeft: 6 });
    treks.upsert(trek);
    const e = thrown(() => bookings.confirm({ trekID: trek.id, travellers: ['A'], phone: '', amountReceived: MAX_AMOUNT + 1, trekStore: treks, ledger, now: new Date(2026, 10, 3) }));
    expect(codeOf(e)).toBe('tooLarge');
    expect(bookings.bookings).toEqual([]);
    expect(treks.treks[0].seatsLeft).toBe(6);
    expect(ledger.entries).toEqual([]);
  });
});

const toInst = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');

// ---- Ledger

const credit = (trek: Id, amount: number, booking: Id = newId(), name = 'Asha', on = date(2026, 11, 3)): LedgerEntry =>
  makeEntry({ date: on, kind: 'Money in', amount, bookingID: booking, customerName: name, shares: [{ trekID: trek, trekName: 'T', amount }] });

const payout = (trek: Id, amount: number, vendor: Id, on = date(2026, 11, 3)): LedgerEntry =>
  makeEntry({ date: on, kind: 'Money out', amount, shares: [{ trekID: trek, trekName: 'T', amount }], vendorID: vendor, vendorName: 'V' });

describe('ledger', () => {
  it('keeps balance and trip totals and persists them', () => {
    const kv = new MemoryKV();
    const ledger = new LedgerStore(kv);
    const a = newId(), b = newId(), v = newId();
    ledger.add(credit(a, 10000)); ledger.add(credit(b, 6000));
    ledger.add(payout(a, 3000, v)); ledger.add(payout(b, 2000, v));
    expect(ledger.balance).toBe(11000);
    expect(ledger.totalIn).toBe(16000);
    expect(ledger.totalOut).toBe(5000);
    expect(ledger.receivedForTrek(a)).toBe(10000);
    expect(ledger.paidOutForTrek(a)).toBe(3000);
    expect(ledger.netForTrek(a)).toBe(7000);
    expect(ledger.netForTrek(b)).toBe(4000);
    expect(ledger.entriesForTrek(a).length).toBe(2);
    expect(ledger.balance).toBe(ledger.netForTrek(a) + ledger.netForTrek(b)); // trip nets add up to the fund balance
    const reloaded = new LedgerStore(kv);
    expect(reloaded.entries.length).toBe(4);
    expect(reloaded.balance).toBe(11000);
  });

  it('needs a trip and a counterpart for every transaction', () => {
    const ledger = new LedgerStore(new MemoryKV());
    const a = newId(), b = newId(), v = newId(), booking = newId();
    const d = date(2026, 11, 3);
    const tryAdd = (e: LedgerEntry) => attempt(() => ledger.add(e)) as AppError | null;
    const share = (t: Id, n: number) => ({ trekID: t, trekName: 'T', amount: n });
    const e = (p: Partial<LedgerEntry> & { kind: EntryKind; amount: number }) => makeEntry({ date: d, ...p });

    expect(tryAdd(credit(a, 0))!.code).toBe('invalidAmount');
    expect(tryAdd(e({ kind: 'Money out', amount: -5, shares: [share(a, -5)], vendorID: v }))!.code).toBe('invalidAmount');
    expect(tryAdd(credit(a, MAX_AMOUNT + 1))!.code).toBe('tooLarge');
    expect(tryAdd(e({ kind: 'Money in', amount: 100, bookingID: booking }))!.code).toBe('tripRequired');
    expect(tryAdd(e({ kind: 'Money out', amount: 100, vendorID: v }))!.code).toBe('tripRequired');
    expect(tryAdd(e({ kind: 'Money out', amount: 100, shares: [share(a, 60), share(b, 40)], vendorID: v }))!.code).toBe('oneTripPerEntry');
    const mismatch = tryAdd(e({ kind: 'Money out', amount: 100, shares: [share(a, 90)], vendorID: v }))!;
    expect(mismatch.code).toBe('sharesMismatch');
    expect(mismatch.message).toBe('₹10 of the amount is not assigned to a trip yet.');
    const over = tryAdd(e({ kind: 'Money out', amount: 100, shares: [share(a, 130)], vendorID: v }))!;
    expect(over.message).toBe('The trip amounts add up to ₹30 more than the entry.');
    expect(tryAdd(e({ kind: 'Money in', amount: 100, shares: [share(a, 100)] }))!.code).toBe('travellerRequired');
    expect(tryAdd(e({ kind: 'Money out', amount: 100, shares: [share(a, 100)] }))!.code).toBe('counterpartRequired');
    expect(tryAdd(e({ kind: 'Money out', amount: 100, shares: [share(a, 100)], vendorID: v, vendorName: 'V', bookingID: booking }))!.code).toBe('counterpartConflict');
    expect(tryAdd(e({ kind: 'Money in', amount: 100, bookingID: booking, shares: [share(a, 100)], vendorID: v }))!.code).toBe('vendorOnlyForPayouts');
    expect(ledger.entries).toEqual([]);

    expect(tryAdd(credit(a, 100, booking))).toBeNull();
    expect(tryAdd(payout(a, 40, v))).toBeNull();
    expect(tryAdd(e({ kind: 'Money out', amount: 10, bookingID: booking, customerName: 'Asha', shares: [share(a, 10)] }))).toBeNull(); // refund
    expect(ledger.entries.length).toBe(3);

    expect(codeOf(thrown(() => ledger.update({ ...ledger.entries[0], shares: [] })))).toBe('tripRequired');
  });

  it('saves one cost split across trips as separate entries, all or none', () => {
    const ledger = new LedgerStore(new MemoryKV());
    const ids = [newId(), newId(), newId()];
    const v = newId();
    const split = LedgerStore.evenSplit(1000, ids.map((id) => ({ id, name: 'T' })));
    expect(split.map((s) => s.amount)).toEqual([334, 333, 333]);
    expect(split.reduce((s, x) => s + x.amount, 0)).toBe(1000);
    expect(LedgerStore.evenSplit(10, [])).toEqual([]);

    const entries = split.map((s) => payout(s.trekID, s.amount, v));
    ledger.addAll(entries);
    expect(ledger.entries.length).toBe(3);
    expect(ledger.totalOut).toBe(1000);
    expect(ledger.paidOutForTrek(ids[0])).toBe(334);

    const before = ledger.entries.length;
    const bad = entries.map((e, i) => (i === 2 ? { ...e, vendorID: undefined, vendorName: undefined } : e));
    expect(thrown(() => ledger.addAll(bad))).toBeInstanceOf(AppError);
    expect(ledger.entries.length).toBe(before);
  });

  it('filters', () => {
    const ledger = new LedgerStore(new MemoryKV());
    const a = newId(), b = newId(), v = newId();
    ledger.add(credit(a, 100, newId(), 'Asha Roy', date(2026, 10, 1)));
    ledger.add(payout(b, 40, v, date(2026, 11, 3)));
    ledger.add(credit(b, 70, newId(), 'Ravi', date(2026, 11, 3)));
    expect(ledger.filtered(filter()).length).toBe(3);
    expect(ledger.filtered(filter({ kind: 'Money in' })).length).toBe(2);
    expect(ledger.filtered(filter({ kind: 'Money in', customer: 'asha' })).length).toBe(1);
    expect(ledger.filtered(filter({ from: date(2026, 11, 1), to: date(2026, 11, 3) })).length).toBe(2); // "to" includes the whole day
    expect(ledger.filtered(filter({ scope: { type: 'trek', id: b } })).length).toBe(2);
    expect(ledger.filtered(filter({ vendorID: v })).length).toBe(1);
    expect(ledger.filtered(filter()).at(-1)!.amount).toBe(100); // newest first
  });

  it('works out payment status', () => {
    expect(LedgerStore.summary(10000, 0).status).toBe('Pending');
    expect(LedgerStore.summary(10000, 4000).status).toBe('Part paid');
    expect(LedgerStore.summary(10000, 4000).balance).toBe(6000);
    expect(LedgerStore.summary(10000, 10000).status).toBe('Paid');
    expect(LedgerStore.summary(10000, 12000).balance).toBe(0); // overpaid never shows negative due
    expect(LedgerStore.summary(undefined, 500).due).toBeUndefined(); // no price set
    expect(LedgerStore.summary(0, 500).due).toBeUndefined();
  });

  it('still loads old ledger files', () => {
    const kv = new MemoryKV();
    kv.set('pahadi.ledger', `[{"id":"${newId()}","date":"2026-11-03T00:00:00Z","kind":"Money out","amount":100,"mode":"Cash","party":"P","note":"","shares":[],"createdAt":"2026-11-03T00:00:00Z"}]`);
    const loaded = new LedgerStore(kv);
    expect(loaded.entries.length).toBe(1);
    expect(loaded.entries[0].vendorID).toBeUndefined();
    expect(loaded.balance).toBe(-100);
  });
});

// ---- Vendors

describe('vendors', () => {
  it('validates, keeps them sorted, searches and persists', () => {
    const kv = new MemoryKV();
    const store = new VendorStore(kv);
    const tryUpsert = (v: Vendor) => attempt(() => store.upsert(v)) as AppError | null;
    expect(tryUpsert(makeVendor({ name: '  ' }))!.code).toBe('missingName');
    expect(tryUpsert(makeVendor({ name: 'A', rate: 0 }))!.code).toBe('badRate');
    expect(tryUpsert(makeVendor({ name: 'A', agreements: [{ trekID: newId(), trekName: 'T', amount: 0 }] }))!.code).toBe('badAgreement');
    const t = newId();
    expect(tryUpsert(makeVendor({ name: 'A', agreements: [{ trekID: t, trekName: 'T', amount: 5 }, { trekID: t, trekName: 'T', amount: 6 }] }))!.code).toBe('duplicateTrip');
    expect(store.vendors).toEqual([]);

    expect(tryUpsert(makeVendor({ name: ' Dorje ', service: 'Guide', rate: 1500, rateUnit: 'per day', tags: ['darjeeling'] }))).toBeNull();
    expect(tryUpsert(makeVendor({ name: 'Asha Homestay', service: 'Stay' }))).toBeNull();
    expect(tryUpsert(makeVendor({ name: 'dorje', service: 'Guide' }))!.code).toBe('duplicateName');
    expect(tryUpsert(makeVendor({ name: 'Dorje', service: 'Porter' }))).toBeNull();
    expect(store.vendors.map((v) => v.name)).toEqual(['Asha Homestay', 'Dorje', 'Dorje']);
    expect(new VendorStore(kv).vendors.length).toBe(3);
    expect(store.search('darj').length).toBe(1);
    expect(store.search('', 'Stay')[0].name).toBe('Asha Homestay');
    expect(store.search('homestay').length).toBe(1);
  });

  it('parses tags', () => {
    expect(parseTags(' Darjeeling, winter ,, DARJEELING\nsikkim')).toEqual(['darjeeling', 'winter', 'sikkim']);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).length).toBe(MAX_TAGS);
    expect(parseTags(' , ')).toEqual([]);
  });

  it('works out owed and paid across views', () => {
    const ledger = new LedgerStore(new MemoryKV());
    const a = newId(), b = newId(), other = newId();
    const vendor = makeVendor({ name: 'Dorje', service: 'Guide', agreements: [{ trekID: a, trekName: 'A', amount: 10000 }, { trekID: b, trekName: 'B', amount: 4000 }] });
    ledger.add(payout(a, 6000, vendor.id)); ledger.add(payout(a, 2500, vendor.id)); ledger.add(payout(b, 2500, vendor.id));
    ledger.add(payout(a, 999, other));
    const st = ledger.statement(vendor);
    expect(st.totalPaid).toBe(11000);
    expect(st.totalAgreed).toBe(14000);
    expect(st.unassignedPaid).toBe(0);
    expect(st.trips.find((x) => x.trekID === a)!.paid).toBe(8500);
    expect(st.trips.find((x) => x.trekID === a)!.owed).toBe(1500);
    expect(st.trips.find((x) => x.trekID === b)!.owed).toBe(1500);
    expect(st.owed).toBe(3000);
    expect(ledger.totalOut).toBe(11999);
    expect(ledger.paidOutForTrek(a)).toBe(9499);
    expect(ledger.paidOutForTrek(b)).toBe(2500);
    expect(ledger.entriesForVendor(vendor.id).length).toBe(3);
    expect(ledger.filtered(filter({ vendorID: vendor.id })).length).toBe(3);

    const c = newId();
    ledger.add(payout(c, 700, vendor.id)); ledger.add(payout(b, 9000, vendor.id));
    const st2 = ledger.statement(vendor);
    expect(st2.trips.find((x) => x.trekID === c)!.agreed).toBe(0);
    expect(st2.trips.find((x) => x.trekID === b)!.owed).toBe(0); // overpaying never shows a negative balance
  });
});

// ---- Backup

class World {
  kv = new MemoryKV();
  treks = new TrekStore(this.kv, noSeed);
  bookings = new BookingStore(this.kv);
  ledger = new LedgerStore(this.kv);
  vendors = new VendorStore(this.kv);
  guidance = new GuidanceStore(this.kv);
  settings = new SettingsStore(this.kv);
}

const snapAt = (w: World) => snapshot(w, new Date(2026, 10, 3));

describe('backup', () => {
  it('round-trips everything into a fresh app', () => {
    const a = new World();
    const trek = makeTrek({ name: 'Gorkhey', pricePerPerson: 9500, startDate: date(2026, 11, 20), seatsLeft: 6 });
    a.treks.upsert(trek);
    const v = a.vendors.upsert(makeVendor({ name: 'Dorje', service: 'Guide', rate: 1500, rateUnit: 'per day', tags: ['darjeeling'], agreements: [{ trekID: trek.id, trekName: 'Gorkhey', amount: 4000 }] }));
    const b = a.bookings.confirm({ trekID: trek.id, travellers: ['Asha', 'Ravi'], phone: '98300 00000', amountReceived: 5000, trekStore: a.treks, ledger: a.ledger, now: new Date(2026, 10, 3) });
    a.ledger.add(payout(trek.id, 1500, v.id));
    a.guidance.add('Always mention the Siliguri pickup');
    a.settings.setSystemPrompt('Custom prompt');
    a.settings.setModel('gemini-flash-lite-latest');

    const text = encodeBackup(snapAt(a));
    expect(text).toContain('PahadiSoulBackup');
    expect(text.toLowerCase()).not.toContain('apikey'); // the Gemini key is never part of a backup

    const fresh = new World();
    restoreBackup(decodeBackup(text), fresh);
    expect(fresh.treks.treks).toEqual(a.treks.treks);
    expect(fresh.bookings.bookings.map((x) => x.id)).toEqual(a.bookings.bookings.map((x) => x.id));
    expect(fresh.vendors.vendors.map((x) => x.id)).toEqual(a.vendors.vendors.map((x) => x.id));
    expect(fresh.guidance.rules.map((r) => r.text)).toEqual(['Always mention the Siliguri pickup']);
    expect(fresh.settings.systemPrompt).toBe('Custom prompt');
    expect(fresh.settings.model).toBe('gemini-flash-lite-latest');
    // Same content; the key order inside a record can differ between a record just made and one read back.
    expect(same(JSON.parse(encodeBackup(snapAt(fresh))), JSON.parse(text))).toBe(true);
    expect(fresh.ledger.balance).toBe(3500);
    expect(fresh.treks.treks[0].seatsLeft).toBe(4);
    expect(fresh.ledger.paymentSummary(b, trek).received).toBe(5000);
    expect(new LedgerStore(fresh.kv).entries.length).toBe(2); // saved
    expect(new TrekStore(fresh.kv, noSeed).treks.length).toBe(1);
  });

  it('replaces existing data on restore, and rules can be undone', () => {
    const src = new World();
    src.guidance.add('New rule');
    const backup = decodeBackup(encodeBackup(snapAt(src)));
    const dst = new World();
    dst.treks.upsert(makeTrek({ name: 'Will be replaced' }));
    dst.guidance.add('Old rule');
    restoreBackup(backup, dst);
    expect(dst.treks.treks).toEqual([]);
    expect(dst.guidance.rules.map((r) => r.text)).toEqual(['New rule']);
    dst.guidance.undo();
    expect(dst.guidance.rules.map((r) => r.text)).toEqual(['Old rule']);
  });

  it('rejects bad files without changing anything', () => {
    const code = (text: string) => codeOf(attempt(() => decodeBackup(text)));
    expect(code('hello')).toBe('notABackup');
    expect(code('{"a":1}')).toBe('notABackup');
    expect(code('{"format":"SomethingElse","version":1,"createdAt":"2026-11-03T00:00:00Z"}')).toBe('notABackup');
    expect(code('{"format":"PahadiSoulBackup","version":99,"createdAt":"2026-11-03T00:00:00Z"}')).toBe('newerVersion');
    const minimal = decodeBackup('{"format":"PahadiSoulBackup","version":1,"createdAt":"2026-11-03T00:00:00Z"}');
    expect(minimal.treks.length + minimal.ledger.length + minimal.vendors.length).toBe(0);
    const t = makeTrek({ name: 'T' });
    expect(code(encodeBackup(backupOf({ treks: [t, t] })))).toBe('invalid');
    const bad = makeEntry({ date: date(2026, 11, 3), kind: 'Money in', amount: -5 });
    expect(code(encodeBackup(backupOf({ ledger: [bad] })))).toBe('invalid');
    expect(code('x'.repeat(MAX_BACKUP_BYTES + 1))).toBe('invalid');
  });

  it('leaves the app untouched when a restore is refused', () => {
    const w = new World();
    w.treks.upsert(makeTrek({ name: 'Keep me' }));
    const t = makeTrek({ name: 'Dup' });
    expect(thrown(() => restoreBackup(backupOf({ treks: [t, t] }), w))).toBeInstanceOf(AppError);
    expect(w.treks.treks.map((x) => x.name)).toEqual(['Keep me']);
  });

  it('loads a backup written by the iPhone app', () => {
    // Upper-case UUIDs, ISO dates, enum words, no keys for empty optionals.
    const json = `{"format":"PahadiSoulBackup","version":1,"createdAt":"2026-11-03T16:30:00Z",
     "treks":[{"id":"73716B09-B359-42AC-8734-2C5699185728","name":"Gorkhey","region":"","durationDays":4,"difficulty":"Moderate","highlights":"","notes":"","startDate":"2026-11-19T18:30:00Z","seatsLeft":4,"pricePerPerson":9500}],
     "bookings":[{"id":"0F534A5C-14C3-4637-BE15-82AD258EF85D","trekID":"73716B09-B359-42AC-8734-2C5699185728","travellers":["Asha","Ravi"],"phone":"","payment":"Part paid","createdAt":"2026-11-03T16:30:00Z"}],
     "ledger":[{"id":"60D87E76-5CC3-4086-B701-FC6D1D9BB2AE","date":"2026-11-03T16:30:00Z","kind":"Money in","amount":5000,"mode":"Bank transfer","party":"Asha","note":"","bookingID":"0F534A5C-14C3-4637-BE15-82AD258EF85D","customerName":"Asha","shares":[{"trekID":"73716B09-B359-42AC-8734-2C5699185728","trekName":"Gorkhey","amount":5000}],"createdAt":"2026-11-03T16:30:00Z"}],
     "vendors":[{"id":"C480C51C-8183-4BC0-B68D-71F82B54BCE7","name":"Dorje","service":"Guide","contactName":"","phone":"","rateUnit":"per day","rate":1500,"tags":["darjeeling"],"notes":"","agreements":[],"createdAt":"2026-11-03T16:30:00Z"}],
     "guidance":[{"id":"E4DBAC8C-7B9A-4906-9F48-2A1B673F100A","text":"Be brief","createdAt":"2026-11-03T16:30:00Z"}]}`;
    const b = decodeBackup(json);
    expect(b.treks[0].difficulty).toBe('Moderate');
    expect(b.bookings[0].payment).toBe('Part paid');
    expect(b.ledger[0].mode).toBe('Bank transfer');
    expect(b.vendors[0].service).toBe('Guide');
    expect(b.vendors[0].rateUnit).toBe('per day');
  });

  it('names the file by day', () => {
    expect(backupFilename(new Date(2026, 10, 3))).toBe('PahadiSoul-backup-2026-11-03.json');
  });

  it('writes the ledger as CSV, oldest first, with formulas neutralised', () => {
    const a = newId(), v = newId();
    const entries = [
      makeEntry({ date: date(2026, 11, 5), kind: 'Money out', amount: 1500, mode: 'Cash', note: 'Guide, "Dorje" advance', shares: [{ trekID: a, trekName: 'Gorkhey', amount: 1500 }], vendorID: v, vendorName: 'Dorje' }),
      makeEntry({ date: date(2026, 11, 3), kind: 'Money in', amount: 5000, mode: 'UPI', bookingID: newId(), customerName: '=cmd|calc', shares: [{ trekID: a, trekName: 'Gorkhey', amount: 5000 }] }),
    ];
    const lines = ledgerCsv(entries).split('\r\n');
    expect(lines[0]).toBe('Date,Type,Amount (INR),Trip,Traveller,Vendor,Paid by,Note');
    expect(lines[1]).toBe("2026-11-03,Money in,5000,Gorkhey,'=cmd|calc,,UPI,"); // oldest first, formula neutralised
    expect(lines[2]).toBe('2026-11-05,Money out,1500,Gorkhey,,Dorje,Cash,"Guide, ""Dorje"" advance"');
    expect(lines.length).toBe(4);
  });
});

function backupOf(p: Partial<Backup>): Backup {
  return { format: BACKUP_FORMAT, version: 1, createdAt: '2026-11-03T00:00:00Z', treks: [], bookings: [], ledger: [], vendors: [], guidance: [], ...p };
}

// ---- Display helpers and settings

describe('display and settings', () => {
  it('groups rupees the Indian way', () => {
    expect(rupees(0)).toBe('₹0');
    expect(rupees(999)).toBe('₹999');
    expect(rupees(1000)).toBe('₹1,000');
    expect(rupees(14500)).toBe('₹14,500');
    expect(rupees(148500)).toBe('₹1,48,500');
    expect(rupees(1000000)).toBe('₹10,00,000');
    expect(signedRupees(-3000)).toBe('−₹3,000');
    expect(grouped(-148500)).toBe('-1,48,500');
  });

  it('persists settings', () => {
    const kv = new MemoryKV();
    const s = new SettingsStore(kv);
    expect(s.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(s.model).toBe('gemini-flash-latest');
    expect(s.lastBackupAt).toBeUndefined();
    s.setSystemPrompt('X'); s.setModel('m'); s.setLastBackupAt(date(2026, 11, 3));
    const again = new SettingsStore(kv);
    expect(again.systemPrompt).toBe('X');
    expect(again.model).toBe('m');
    expect(again.lastBackupAt).toBe(date(2026, 11, 3));
    again.resetPrompt();
    expect(again.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

