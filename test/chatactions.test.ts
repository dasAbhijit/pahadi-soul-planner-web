import './helpers';
import { describe, expect, it } from 'vitest';
import { Chat, DRAFT_INTRO, type ChatActionDeps } from '../src/core/chat';
import { MAX_DRAFTS_PER_REPLY, TOOL_BOOKING, TOOL_PAYMENT_IN, TOOL_PAYMENT_OUT, TOOL_TREK, TOOL_VENDOR, draftFromCall, draftsSummary, matchBookings, toolDeclarations, trekRefs } from '../src/core/chatactions';
import { makeStreamRequest, parseSSELine, type GeminiEvent, type GeminiMessage } from '../src/core/gemini';
import { buildPrompt } from '../src/core/prompt';
import { Secrets, SettingsStore } from '../src/core/settings';
import { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from '../src/core/stores';
import { MemoryKV } from '../src/core/storage';
import { makeBooking, makeTrek, makeVendor, type Trek } from '../src/core/models';
import type { Role } from '../src/core/roles';
import { toInstant } from '../src/core/ids';
import { DEFAULT_SYSTEM_PROMPT } from '../src/core/prompt';

const NOW = new Date(2026, 10, 6, 10, 0, 0); // Fri 6 Nov 2026
const DAY = 86_400_000;
const start = (days: number) => toInstant(new Date(NOW.getTime() + days * DAY));

async function* stream(events: GeminiEvent[]): AsyncGenerator<GeminiEvent> { for (const e of events) yield e; }

class Harness {
  kv = new MemoryKV();
  treks = new TrekStore(this.kv, () => []);
  bookings = new BookingStore(this.kv);
  ledger = new LedgerStore(this.kv);
  guidance = new GuidanceStore(this.kv);
  vendors = new VendorStore(this.kv);
  settings = new SettingsStore(this.kv);
  secrets = new Secrets(this.kv);
  role: Role | undefined = 'Staff';
  next: GeminiEvent[] = [];
  seen: { system: string; history: GeminiMessage[]; tools: string[] }[] = [];
  gorkhey: Trek;

  constructor() {
    this.gorkhey = makeTrek({ name: 'Gorkhey – Samanden', durationDays: 4, startDate: start(36), pricePerPerson: 9500, seatsLeft: 9, seatCapacity: 9 });
    this.treks.upsert(this.gorkhey);
    this.secrets.setGeminiKey('KEY');
    this.settings.acknowledgeChatActionsNotice();
  }

  chat(): Chat {
    const deps: ChatActionDeps = { bookings: this.bookings, ledger: this.ledger, role: () => this.role };
    return new Chat(this.settings, this.treks, this.guidance, this.vendors, this.secrets, (_k, _m, system, history, _s, tools) => {
      this.seen.push({ system, history, tools: (tools ?? []).map((t) => t.name) });
      return stream(this.next);
    }, deps);
  }
}

const bookingCall = (over: Record<string, unknown> = {}): GeminiEvent => ({
  type: 'draft', tool: TOOL_BOOKING,
  args: { trek_ref: 'T1', travellers: ['Rohit Sharma', 'Anita Roy'], phone: '98300 11122', amount_received: 5000, payment_mode: 'UPI', ...over },
});

describe('chat actions: drafts are only cards', () => {
  it('shows a booking card and writes nothing until Approve', async () => {
    const h = new Harness();
    h.next = [{ type: 'text', text: 'Here is the booking.' }, bookingCall()];
    const chat = h.chat();
    await chat.send('Book Rohit Sharma and Anita Roy on Gorkhey', NOW);
    const draft = chat.messages[1].drafts![0];
    expect(draft.state).toBe('pending');
    expect(draft.data).toMatchObject({ kind: 'booking', trekID: h.gorkhey.id, travellers: ['Rohit Sharma', 'Anita Roy'], amountReceived: 5000, mode: 'UPI' });
    expect(h.bookings.bookings.length).toBe(0);
    expect(h.ledger.entries.length).toBe(0);
    expect(h.treks.trek(h.gorkhey.id)!.seatsLeft).toBe(9);

    const view = chat.viewDraft(draft, NOW)!;
    expect(view.canApprove).toBe(true);
    expect(view.sums.join(' ')).toContain('9 left → 7 left');
    expect(view.sums.join(' ')).toContain('Part paid');
    expect(view.rows.find((r) => r.label === 'Due')!.value).toBe('2 × ₹9,500 = ₹19,000');

    expect(chat.approveDraft(draft.id, false, NOW)).toBeNull();
    expect(chat.findDraft(draft.id)!.state).toBe('applied');
    expect(chat.findDraft(draft.id)!.result).toContain('Booking added');
    expect(h.bookings.bookings.length).toBe(1);
    expect(h.ledger.entries.length).toBe(1);
    expect(h.ledger.entries[0]).toMatchObject({ kind: 'Money in', amount: 5000, mode: 'UPI' });
    expect(h.treks.trek(h.gorkhey.id)!.seatsLeft).toBe(7);
  });

  it('approves once: a second tap writes nothing more', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book them', NOW);
    const id = chat.messages[1].drafts![0].id;
    chat.approveDraft(id, false, NOW);
    chat.approveDraft(id, false, NOW);
    chat.approveDraft(id, true, NOW);
    expect(h.bookings.bookings.length).toBe(1);
    expect(h.ledger.entries.length).toBe(1);
  });

  it('Deny writes nothing, tells the assistant next time, and cannot be approved afterwards', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book them', NOW);
    const id = chat.messages[1].drafts![0].id;
    chat.denyDraft(id, NOW);
    expect(chat.findDraft(id)!.state).toBe('denied');
    chat.approveDraft(id, false, NOW);
    expect(h.bookings.bookings.length).toBe(0);
    h.next = [{ type: 'text', text: 'Okay' }];
    await chat.send('thanks', NOW);
    const last = h.seen[h.seen.length - 1].history;
    expect(last[last.length - 1].text).toContain(`${id} was denied`);
    expect(last[last.length - 1].text).toContain('nothing was saved');
    // the message on screen is only what was typed
    expect(chat.messages[chat.messages.length - 2].text).toBe('thanks');
    expect(h.settings.chatActionLog.map((x) => x.outcome)).toEqual(['denied']);
  });

  it('typing yes changes nothing: there is no tool to approve', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book them', NOW);
    h.next = [{ type: 'text', text: 'Tap Approve on the card above.' }];
    await chat.send('yes confirm it', NOW);
    expect(h.bookings.bookings.length).toBe(0);
    expect(chat.messages[1].drafts![0].state).toBe('pending');
    expect(toolDeclarations('Owner').map((t) => t.name).every((n) => n.startsWith('draft_'))).toBe(true);
  });

  it('a typed change replaces the old card only when the assistant names it', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book Rohit and Anita', NOW);
    h.next = [bookingCall({ travellers: ['Rohit Sharma', 'Anita Roy', 'Joy Das'], replaces: 'D1' })];
    await chat.send('make it 3', NOW);
    expect(chat.findDraft('D1')!.state).toBe('replaced');
    expect(chat.findDraft('D2')!.state).toBe('pending');
    // an unrelated second booking leaves the first alone
    h.next = [bookingCall({ travellers: ['Mita Das'] })];
    await chat.send('also book Mita', NOW);
    expect(chat.findDraft('D2')!.state).toBe('pending');
    expect(chat.findDraft('D3')!.state).toBe('pending');
    chat.approveDraft('D1', false, NOW);
    expect(h.bookings.bookings.length).toBe(0);
  });

  it('tells the assistant what drafts exist, and what happened to them', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book them', NOW);
    chat.approveDraft('D1', false, NOW);
    h.next = [{ type: 'text', text: 'ok' }];
    await chat.send('send them a message', NOW);
    const hist = h.seen[1].history;
    expect(hist[1].text).toContain('drafts shown to the user, not saved: D1 (booking for Rohit Sharma + 1 on Gorkhey');
    expect(hist[2].text).toContain('D1 was approved and saved by the user.');
  });

  it('keeps at most five cards from one reply', async () => {
    const h = new Harness();
    h.next = Array.from({ length: 8 }, (_, i) => bookingCall({ travellers: [`Person ${i}`] }));
    const chat = h.chat();
    await chat.send('book many', NOW);
    expect(chat.messages[1].drafts!.length).toBe(MAX_DRAFTS_PER_REPLY);
    expect(chat.messages[1].text).toBe(DRAFT_INTRO);
  });
});

describe('chat actions: checks happen on the phone', () => {
  it('asks which trek when the reference is not in the catalogue, and Approve stays off', async () => {
    const h = new Harness();
    h.next = [bookingCall({ trek_ref: 'T9' })];
    const chat = h.chat();
    await chat.send('Book on Kedarnath', NOW);
    const d = chat.messages[1].drafts![0];
    expect((d.data as { trekID?: string }).trekID).toBeUndefined();
    let v = chat.viewDraft(d, NOW)!;
    expect(v.canApprove).toBe(false);
    expect(v.choice?.field).toBe('trek');
    expect(chat.approveDraft(d.id, false, NOW)).toBe('Choose the trek.');
    expect(h.bookings.bookings.length).toBe(0);
    chat.chooseForDraft(d.id, 'trek', h.gorkhey.id);
    v = chat.viewDraft(chat.findDraft(d.id)!, NOW)!;
    expect(v.canApprove).toBe(true);
  });

  it('refuses at Approve when another phone took the seats, and keeps the card open', async () => {
    const h = new Harness();
    h.next = [bookingCall({ travellers: ['Anil Das', 'Mita Das', 'Joy Das'], amount_received: undefined, payment_mode: undefined })];
    const chat = h.chat();
    await chat.send('Book three', NOW);
    h.treks.upsert({ ...h.treks.trek(h.gorkhey.id)!, seatsLeft: 1 });
    const why = chat.approveDraft('D1', false, NOW);
    expect(why).toBe('Only 1 seat left.');
    expect(chat.findDraft('D1')!.state).toBe('pending');
    expect(chat.findDraft('D1')!.error).toBe('Only 1 seat left.');
    expect(h.bookings.bookings.length).toBe(0);
    expect(h.treks.trek(h.gorkhey.id)!.seatsLeft).toBe(1);
  });

  it('asks how it was paid instead of assuming UPI', async () => {
    const h = new Harness();
    h.next = [bookingCall({ payment_mode: undefined })];
    const chat = h.chat();
    await chat.send('Book them, 5000 received', NOW);
    const d = chat.messages[1].drafts![0];
    expect(chat.viewDraft(d, NOW)!.choice?.field).toBe('mode');
    expect(chat.approveDraft(d.id, false, NOW)).toBe('Choose how the money was paid.');
    chat.chooseForDraft(d.id, 'mode', 'Cash');
    expect(chat.approveDraft(d.id, false, NOW)).toBeNull();
    expect(h.ledger.entries[0].mode).toBe('Cash');
  });

  it('warns about a likely duplicate booking and saves it only with a second, deliberate tap', async () => {
    const h = new Harness();
    h.bookings.confirm({ trekID: h.gorkhey.id, travellers: ['rohit sharma'], phone: '1', trekStore: h.treks, ledger: h.ledger, now: NOW });
    h.next = [bookingCall({ amount_received: undefined, payment_mode: undefined })];
    const chat = h.chat();
    await chat.send('Book Rohit', NOW);
    const v = chat.viewDraft(chat.messages[1].drafts![0], NOW)!;
    expect(v.needsAnyway).toBe(true);
    expect(v.warnings[0]).toContain('already has a booking');
    expect(chat.approveDraft('D1', false, NOW)).toContain('already has a booking');
    expect(h.bookings.bookings.length).toBe(1);
    expect(chat.approveDraft('D1', true, NOW)).toBeNull();
    expect(h.bookings.bookings.length).toBe(2);
  });

  it('refuses a draft for a trek that has already run', async () => {
    const h = new Harness();
    const old = makeTrek({ name: 'Old', startDate: start(-30), seatsLeft: 3, durationDays: 2 });
    h.treks.upsert(old);
    const refs = trekRefs(h.treks.treks, NOW);
    const oldRef = refs.find((r) => r.trek.id === old.id)!.ref;
    h.next = [bookingCall({ trek_ref: oldRef, amount_received: undefined, payment_mode: undefined })];
    const chat = h.chat();
    await chat.send('Book on Old', NOW);
    expect(chat.approveDraft('D1', false, NOW)).toBe('This trek has already started or finished.');
    expect(h.bookings.bookings.length).toBe(0);
  });
});

describe('chat actions: a payment received', () => {
  const payCall = (over: Record<string, unknown> = {}): GeminiEvent => ({
    type: 'draft', tool: TOOL_PAYMENT_IN, args: { trek_ref: 'T1', traveller_name: 'Rohit', amount: 14000, payment_mode: 'UPI', ...over },
  });
  function twoRohits(h: Harness) {
    const a = h.bookings.confirm({ trekID: h.gorkhey.id, travellers: ['Rohit Sharma', 'Anita Roy'], phone: '1', amountReceived: 5000, mode: 'UPI', trekStore: h.treks, ledger: h.ledger, now: NOW });
    const b = h.bookings.confirm({ trekID: h.gorkhey.id, travellers: ['Rohit Verma'], phone: '2', trekStore: h.treks, ledger: h.ledger, now: NOW });
    return { a, b };
  }

  it('asks which Rohit, and saves only after one is chosen', async () => {
    const h = new Harness();
    const { a } = twoRohits(h);
    const before = h.ledger.entries.length;
    h.next = [payCall()];
    const chat = h.chat();
    await chat.send('Rohit ne 14000 UPI se balance de diya', NOW);
    const d = chat.messages[1].drafts![0];
    let v = chat.viewDraft(d, NOW)!;
    expect(v.choice?.field).toBe('booking');
    expect(v.choice!.options.map((o) => o.label)).toEqual(expect.arrayContaining(['Rohit Sharma + 1', 'Rohit Verma']));
    expect(v.canApprove).toBe(false);
    expect(chat.approveDraft(d.id, false, NOW)).toBe('Choose the traveller.');
    expect(h.ledger.entries.length).toBe(before);

    chat.chooseForDraft(d.id, 'booking', a.id);
    v = chat.viewDraft(chat.findDraft(d.id)!, NOW)!;
    expect(v.canApprove).toBe(true);
    expect(v.sums.join(' ')).toContain('Booking due ₹19,000 · received so far ₹5,000');
    expect(v.sums.join(' ')).toContain('Part paid to Paid');
    expect(chat.approveDraft(d.id, false, NOW)).toBeNull();
    const e = h.ledger.entries.find((x) => x.amount === 14000)!;
    expect(e).toMatchObject({ kind: 'Money in', bookingID: a.id, customerName: 'Rohit Sharma', mode: 'UPI' });
    expect(e.shares).toEqual([{ trekID: h.gorkhey.id, trekName: h.gorkhey.name, amount: 14000 }]);
    expect(h.ledger.paymentSummary(h.bookings.booking(a.id)!, h.treks.trek(h.gorkhey.id)).status).toBe('Paid');
  });

  it('picks the traveller by itself when only one booking matches', async () => {
    const h = new Harness();
    twoRohits(h);
    h.next = [payCall({ traveller_name: 'Rohit Verma', amount: 9500 })];
    const chat = h.chat();
    await chat.send('Rohit Verma paid 9500', NOW);
    const d = chat.messages[1].drafts![0];
    expect(d.data.kind === 'paymentIn' && d.data.bookingID).toBeTruthy();
    expect(chat.approveDraft(d.id, false, NOW)).toBeNull();
    expect(h.ledger.entries.some((e) => e.amount === 9500 && e.customerName === 'Rohit Verma')).toBe(true);
  });

  it('flags a payment that repeats one already recorded', async () => {
    const h = new Harness();
    const { a } = twoRohits(h);
    h.next = [payCall({ traveller_name: 'Rohit Sharma', amount: 5000, date: '2026-11-06' })];
    const chat = h.chat();
    await chat.send('Rohit Sharma 5000', NOW);
    const v = chat.viewDraft(chat.messages[1].drafts![0], NOW)!;
    expect(v.warnings.some((w) => w.startsWith('Possible duplicate'))).toBe(true);
    expect(chat.approveDraft('D1', false, NOW)).toContain('Possible duplicate');
    expect(h.ledger.entries.filter((e) => e.bookingID === a.id).length).toBe(1);
    expect(chat.approveDraft('D1', true, NOW)).toBeNull();
    expect(h.ledger.entries.filter((e) => e.bookingID === a.id).length).toBe(2);
  });

  it('reads the date as that day, and weekday shows on the card', () => {
    const refs = { treks: trekRefs([makeTrek({ name: 'X', startDate: start(10) })], NOW), vendors: [] };
    const p = draftFromCall(TOOL_PAYMENT_IN, { trek_ref: 'T1', traveller_name: 'A', amount: '2500', date: '2026-12-12' }, refs, NOW)!;
    expect(p.data.kind === 'paymentIn' && p.data.amount).toBe(2500);
    expect(new Date(p.data.kind === 'paymentIn' ? p.data.date : '').getDay()).toBe(6); // Saturday
    const bad = draftFromCall(TOOL_PAYMENT_IN, { trek_ref: 'T1', traveller_name: 'A', amount: 12.5, date: '2026-02-30' }, refs, NOW)!;
    expect(bad.data.kind === 'paymentIn' && bad.data.amount).toBeUndefined();
    expect(bad.data.kind === 'paymentIn' && bad.data.date).toBe(toInstant(NOW));
  });

  it('matches names loosely but never an empty name', () => {
    const t = makeTrek({ name: 'T', startDate: start(5) });
    const b1 = makeBooking({ trekID: t.id, travellers: ['Rohit Sharma'], phone: '+91 98300 11122' });
    expect(matchBookings([b1], t.id, 'rohit').length).toBe(1);
    expect(matchBookings([b1], t.id, 'Sharma Rohit').length).toBe(1);
    expect(matchBookings([b1], t.id, '9830011122').length).toBe(1);
    expect(matchBookings([b1], t.id, '').length).toBe(0);
    expect(matchBookings([b1], t.id, 'Anita').length).toBe(0);
  });
});

describe('chat actions: Edit, roles and the switch', () => {
  it('a draft saved from the form is marked as such, and counted as edited', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book them', NOW);
    chat.draftSavedFromForm('D1', 'Booking added · Rohit Sharma + 1', NOW);
    expect(chat.findDraft('D1')!.state).toBe('saved');
    chat.approveDraft('D1', false, NOW);
    expect(h.bookings.bookings.length).toBe(0); // the form saved it, not the card
    expect(h.settings.chatActionLog.map((x) => x.outcome)).toEqual(['edited']);
  });

  it('offers no tools, and shows no cards, with nobody signed in, with the switch off, or before the notice is read', async () => {
    const h = new Harness();
    h.role = undefined;
    h.next = [bookingCall()];
    let chat = h.chat();
    await chat.send('Book them', NOW);
    expect(h.seen[0].tools).toEqual([]);
    expect(chat.messages[1].drafts).toBeUndefined();

    h.role = 'Owner';
    h.settings.setChatActions(false);
    chat = h.chat();
    await chat.send('Book them', NOW);
    expect(h.seen[1].tools).toEqual([]);
    expect(h.seen[1].system).not.toContain('CHAT ACTIONS');
    expect(chat.messages[1].drafts).toBeUndefined();

    h.settings.setChatActions(true);
    const fresh = new Harness();
    fresh.settings = new SettingsStore(new MemoryKV());
    fresh.secrets.setGeminiKey('K');
    fresh.next = [bookingCall()];
    const c2 = fresh.chat();
    expect(c2.actionsNeedNotice).toBe(true);
    await c2.send('Book them', NOW);
    expect(fresh.seen[0].tools).toEqual([]);
  });

  it('gives the model the tools for the role, the catalogue references and the rules; the cards re-check the role', async () => {
    const h = new Harness();
    h.next = [{ type: 'text', text: 'hi' }];
    const chat = h.chat();
    await chat.send('hello', NOW);
    expect(h.seen[0].tools).toEqual([TOOL_BOOKING, TOOL_PAYMENT_IN]);
    expect(h.seen[0].system).toContain('# CHAT ACTIONS');
    expect(h.seen[0].system).toContain('[T1] Gorkhey – Samanden');
    expect(h.seen[0].system).toContain('typing "yes"');
    // the same trek line with no tools carries no reference
    expect(buildPrompt({ basePrompt: DEFAULT_SYSTEM_PROMPT, treks: h.treks.treks, now: NOW })).not.toContain('[T1]');
    // a role that loses its sign-in cannot approve a card that was already on screen
    h.next = [bookingCall()];
    await chat.send('Book them', NOW);
    h.role = undefined;
    expect(chat.approveDraft('D1', false, NOW)).toBe('Your role cannot save this.');
    expect(h.bookings.bookings.length).toBe(0);
  });

  it('keeps the change of role out of Staff reach for things that are not drafts', () => {
    expect(toolDeclarations(undefined)).toEqual([]);
    expect(toolDeclarations('Staff').map((t) => t.name)).toEqual([TOOL_BOOKING, TOOL_PAYMENT_IN]);
    for (const role of ['Manager', 'Owner'] as const) expect(toolDeclarations(role).map((t) => t.name)).toEqual([TOOL_BOOKING, TOOL_PAYMENT_IN, TOOL_PAYMENT_OUT, TOOL_TREK, TOOL_VENDOR]);
  });

  it('a new chat forgets cards and notes', async () => {
    const h = new Harness();
    h.next = [bookingCall()];
    const chat = h.chat();
    await chat.send('Book them', NOW);
    chat.denyDraft('D1', NOW);
    chat.newChat();
    expect(chat.messages).toEqual([]);
    h.next = [bookingCall()];
    await chat.send('Book them again', NOW);
    expect(chat.messages[1].drafts![0].id).toBe('D1');
    expect(h.seen[h.seen.length - 1].history[0].text).toBe('Book them again');
  });
});

describe('chat actions: the Gemini side', () => {
  it('reads a draft call, and ignores a call it does not know', () => {
    const line = (call: unknown) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: call }] } }] })}`;
    expect(parseSSELine(line({ name: TOOL_BOOKING, args: { trek_ref: 'T1', travellers: ['A'] } }))).toEqual([{ type: 'draft', tool: TOOL_BOOKING, args: { trek_ref: 'T1', travellers: ['A'] } }]);
    expect(parseSSELine(line({ name: 'delete_everything', args: {} }))).toEqual([]);
    expect(parseSSELine(line({ name: TOOL_BOOKING, args: 'oops' }))).toEqual([]);
  });

  it('sends the draft tools beside the rule tool, with the key in a header', () => {
    const req = makeStreamRequest('SECRET', 'gemini-flash-latest', 'sys', [{ role: 'user', text: 'hi' }], true, toolDeclarations('Staff'));
    const body = JSON.parse(req.body);
    expect(body.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(['propose_guidance_rule', TOOL_BOOKING, TOOL_PAYMENT_IN]);
    expect(req.url).not.toContain('SECRET');
  });
});

describe('chat actions: trips, vendors and money out (Managers and Owners)', () => {
  const trekCall = (over: Record<string, unknown> = {}): GeminiEvent => ({
    type: 'draft', tool: TOOL_TREK, args: { name: 'Triund Weekend', duration_days: 2, difficulty: 'Easy', start_date: '2026-12-20', price_per_person: 4500, seats: 20, ...over },
  });
  const vendorCall = (over: Record<string, unknown> = {}): GeminiEvent => ({
    type: 'draft', tool: TOOL_VENDOR, args: { name: 'Himalayan Stays', service: 'Stay', phone: '98320 55501', rate: 1800, rate_unit: 'per night', tags: ['Darjeeling', 'homestay'], agreed_trek_ref: 'T1', agreed_amount: 30000, ...over },
  });
  const outCall = (over: Record<string, unknown> = {}): GeminiEvent => ({
    type: 'draft', tool: TOOL_PAYMENT_OUT, args: { trek_ref: 'T1', vendor_ref: 'V1', amount: 12000, payment_mode: 'Cash', ...over },
  });
  function manager(): Harness { const h = new Harness(); h.role = 'Manager'; return h; }

  it('a Staff phone gets no such tools, and a call for one makes no card', async () => {
    const h = new Harness();
    h.next = [trekCall(), vendorCall(), outCall()];
    const chat = h.chat();
    await chat.send('add a trek', NOW);
    expect(h.seen[0].tools).toEqual([TOOL_BOOKING, TOOL_PAYMENT_IN]);
    expect(chat.messages[1].drafts).toBeUndefined();
    expect(h.treks.treks.length).toBe(1);
    expect(h.vendors.vendors.length).toBe(0);
    expect(h.ledger.entries.length).toBe(0);
    expect(h.seen[0].system).not.toContain('[V1]');
    expect(draftsSummary('Staff')).toBe('bookings and payments received');
    expect(draftsSummary('Owner')).toBe('trips, vendors, bookings and payments');
  });

  it('drafts a trek, writes nothing until Approve, then adds it like the form does', async () => {
    const h = manager();
    h.next = [trekCall()];
    const chat = h.chat();
    await chat.send('Add Triund weekend trek 20 Dec', NOW);
    const d = chat.messages[1].drafts![0];
    const v = chat.viewDraft(d, NOW)!;
    expect(v.canApprove).toBe(true);
    expect(v.rows.find((r) => r.label === 'Dates')!.value).toBe('Sun 20 Dec 2026 to Mon 21 Dec 2026');
    expect(v.rows.find((r) => r.label === 'Price')!.value).toBe('₹4,500 per person');
    expect(h.treks.treks.length).toBe(1);
    expect(chat.approveDraft(d.id, false, NOW)).toBeNull();
    const t = h.treks.treks.find((x) => x.name === 'Triund Weekend')!;
    expect(t).toMatchObject({ durationDays: 2, difficulty: 'Easy', pricePerPerson: 4500, seatsLeft: 20, seatCapacity: 20 });
    expect(new Date(t.startDate!).getDate()).toBe(20);
    expect(chat.findDraft(d.id)!.recordIDs).toEqual([t.id]);
    // the next message's catalogue now carries it
    h.next = [{ type: 'text', text: 'ok' }];
    await chat.send('thanks', NOW);
    expect(h.seen[1].system).toContain('Triund Weekend');
  });

  it('asks for the difficulty and the days instead of assuming, and warns about a trek that is already there', async () => {
    const h = manager();
    h.next = [trekCall({ difficulty: undefined, duration_days: undefined, name: 'Gorkhey – Samanden', start_date: undefined })];
    const chat = h.chat();
    await chat.send('add Gorkhey', NOW);
    const d = chat.messages[1].drafts![0];
    let v = chat.viewDraft(d, NOW)!;
    expect(v.choice?.field).toBe('difficulty');
    expect(v.problems).toContain('Say how many days (use Edit).');
    expect(chat.approveDraft(d.id, false, NOW)).toBe('Say how many days (use Edit).');
    expect(h.treks.treks.length).toBe(1);
    // a dated clash is a warning, not a block
    h.next = [trekCall({ name: 'gorkhey – samanden', start_date: toInstant(new Date(h.gorkhey.startDate!)).slice(0, 10) })];
    await chat.send('add it again', NOW);
    chat.chooseForDraft('D2', 'difficulty', 'Moderate');
    v = chat.viewDraft(chat.findDraft('D2')!, NOW)!;
    expect(v.warnings.some((w) => w.includes('is already in Treks'))).toBe(true);
  });

  it('adds a vendor with one agreed amount, and never changes one that exists', async () => {
    const h = manager();
    h.next = [vendorCall()];
    const chat = h.chat();
    await chat.send('new stay vendor Himalayan Stays', NOW);
    const d = chat.messages[1].drafts![0];
    expect(chat.viewDraft(d, NOW)!.canApprove).toBe(true);
    expect(h.vendors.vendors.length).toBe(0);
    expect(chat.approveDraft(d.id, false, NOW)).toBeNull();
    const v = h.vendors.vendors[0];
    expect(v).toMatchObject({ name: 'Himalayan Stays', service: 'Stay', rate: 1800, rateUnit: 'per night', phone: '98320 55501' });
    expect(v.tags).toEqual(['darjeeling', 'homestay']);
    expect(v.agreements).toEqual([{ trekID: h.gorkhey.id, trekName: h.gorkhey.name, amount: 30000 }]);

    h.next = [vendorCall({ agreed_trek_ref: undefined, agreed_amount: undefined })];
    await chat.send('add it again', NOW);
    const again = chat.viewDraft(chat.findDraft('D2')!, NOW)!;
    expect(again.canApprove).toBe(false);
    expect(again.problems[0]).toContain('already exists. To change it, open it in Vendors.');
    expect(h.vendors.vendors.length).toBe(1);
  });

  it('asks for the service and the rate unit, and warns about a look-alike name', async () => {
    const h = manager();
    h.vendors.upsert(makeVendor({ name: 'Himalayan Stays Darjeeling', service: 'Stay' }));
    h.next = [vendorCall({ service: undefined, rate_unit: undefined, agreed_trek_ref: undefined, agreed_amount: undefined })];
    const chat = h.chat();
    await chat.send('new vendor', NOW);
    const d = chat.messages[1].drafts![0];
    expect(chat.viewDraft(d, NOW)!.choice?.field).toBe('service');
    chat.chooseForDraft(d.id, 'service', 'Stay');
    expect(chat.viewDraft(chat.findDraft(d.id)!, NOW)!.choice?.field).toBe('rateUnit');
    chat.chooseForDraft(d.id, 'rateUnit', 'per night');
    const v = chat.viewDraft(chat.findDraft(d.id)!, NOW)!;
    expect(v.needsAnyway).toBe(true); // a look-alike name is a warning: the button reads Add anyway
    expect(chat.approveDraft(d.id, false, NOW)).toContain('already in Vendors');
    expect(h.vendors.vendors.length).toBe(1);
    expect(chat.approveDraft(d.id, true, NOW)).toBeNull();
    expect(h.vendors.vendors.length).toBe(2);
  });

  it('lists vendors by reference to a Manager, with no phone numbers, and records money out against the vendor and the trip', async () => {
    const h = manager();
    const stays = h.vendors.upsert(makeVendor({ name: 'Himalayan Stays', service: 'Stay', phone: '9800000000', rate: 1800, rateUnit: 'per night', agreements: [{ trekID: h.gorkhey.id, trekName: h.gorkhey.name, amount: 30000 }] }));
    h.ledger.add({ ...makeEntryLike(h, 18000, 'Money out'), vendorID: stays.id, vendorName: stays.name, party: stays.name });
    h.next = [outCall()];
    const chat = h.chat();
    await chat.send('Paid Himalayan Stays 12000 cash for Gorkhey', NOW);
    expect(h.seen[0].system).toContain('[V1] Himalayan Stays');
    expect(h.seen[0].system).not.toContain('9800000000');
    expect(h.seen[0].tools).toEqual([TOOL_BOOKING, TOOL_PAYMENT_IN, TOOL_PAYMENT_OUT, TOOL_TREK, TOOL_VENDOR]);
    const d = chat.messages[1].drafts![0];
    const v = chat.viewDraft(d, NOW)!;
    expect(v.sums).toEqual(['Agreed ₹30,000 · paid so far ₹18,000', 'After this: paid ₹30,000, nothing owed']);
    expect(v.canApprove).toBe(true);
    expect(chat.approveDraft(d.id, false, NOW)).toBeNull();
    const e = h.ledger.entries.find((x) => x.amount === 12000)!;
    expect(e).toMatchObject({ kind: 'Money out', vendorID: stays.id, vendorName: 'Himalayan Stays', mode: 'Cash' });
    expect(e.bookingID).toBeUndefined();
    expect(e.shares).toEqual([{ trekID: h.gorkhey.id, trekName: h.gorkhey.name, amount: 12000 }]);
    expect(h.ledger.paidToVendor(stays.id, h.gorkhey.id)).toBe(30000);
  });

  it('warns about money out above what was agreed and about a repeat, and asks which vendor when the reference is unknown', async () => {
    const h = manager();
    const stays = h.vendors.upsert(makeVendor({ name: 'Himalayan Stays', service: 'Stay', agreements: [{ trekID: h.gorkhey.id, trekName: h.gorkhey.name, amount: 10000 }] }));
    h.vendors.upsert(makeVendor({ name: 'Dorje Guide', service: 'Guide' }));
    h.next = [outCall({ amount: 12000, vendor_ref: 'V2' }), outCall({ vendor_ref: 'V9', vendor_name: 'Himalayan' })];
    const chat = h.chat();
    await chat.send('pay', NOW);
    const over = chat.viewDraft(chat.messages[1].drafts![0], NOW)!;
    expect(over.warnings.some((w) => w.includes('₹2,000 more than was agreed'))).toBe(true);
    // V1 is Dorje (the store orders by name), V2 is Himalayan Stays. A wrong reference never silently picks someone: only a name that matches one vendor does
    const second = chat.messages[1].drafts![1];
    expect((second.data as { vendorID?: string }).vendorID).toBe(stays.id); // 'Himalayan' matches exactly one vendor by name
    chat.approveDraft(chat.messages[1].drafts![1].id, true, NOW);
    h.next = [outCall({ vendor_ref: 'V9', vendor_name: undefined })];
    await chat.send('pay someone', NOW);
    const unknown = chat.viewDraft(chat.findDraft('D3')!, NOW)!;
    expect(unknown.choice?.field).toBe('vendor');
    expect(unknown.canApprove).toBe(false);
  });

  it('records a refund to a traveller, and refuses a vendor and a traveller together', async () => {
    const h = manager();
    const b = h.bookings.confirm({ trekID: h.gorkhey.id, travellers: ['Anil Das'], phone: '1', amountReceived: 9500, mode: 'UPI', trekStore: h.treks, ledger: h.ledger, now: NOW });
    h.bookings.cancel(b.id, h.treks, NOW);
    h.vendors.upsert(makeVendor({ name: 'Dorje', service: 'Guide' }));
    h.next = [outCall({ vendor_ref: undefined, traveller_name: 'Anil', amount: 9500, payment_mode: 'UPI' }), outCall({ traveller_name: 'Anil' })];
    const chat = h.chat();
    await chat.send('refund Anil', NOW);
    const refund = chat.messages[1].drafts![0];
    const v = chat.viewDraft(refund, NOW)!;
    expect(v.rows.find((r) => r.label === 'Refund to')!.value).toBe('Anil Das');
    expect(v.sums[0]).toBe('Received from them, less refunds so far: ₹9,500');
    expect(chat.approveDraft(refund.id, false, NOW)).toBeNull();
    const e = h.ledger.entries.find((x) => x.kind === 'Money out')!;
    expect(e).toMatchObject({ bookingID: b.id, customerName: 'Anil Das', amount: 9500 });
    expect(e.vendorID).toBeUndefined();
    const both = chat.viewDraft(chat.messages[1].drafts![1], NOW)!;
    expect(both.canApprove).toBe(false);
    expect(both.problems.join(' ')).toContain('either a vendor or a traveller');
  });

  it('Edit then save on a trip or vendor draft marks the card and keeps the record ids', async () => {
    const h = manager();
    h.next = [trekCall(), vendorCall({ agreed_trek_ref: undefined, agreed_amount: undefined })];
    const chat = h.chat();
    await chat.send('add both', NOW);
    chat.draftSavedFromForm('D1', 'Trek added · Triund Weekend', NOW, ['ID-1']);
    expect(chat.findDraft('D1')).toMatchObject({ state: 'saved', recordIDs: ['ID-1'] });
    chat.denyDraft('D2', NOW);
    expect(h.settings.chatActionLog.map((x) => x.outcome)).toEqual(['edited', 'denied']);
  });
});

function makeEntryLike(h: Harness, amount: number, kind: 'Money in' | 'Money out') {
  return {
    id: crypto.randomUUID().toUpperCase(), date: toInstant(NOW), kind, amount, mode: 'UPI' as const, party: '', note: '', createdAt: toInstant(NOW),
    shares: [{ trekID: h.gorkhey.id, trekName: h.gorkhey.name, amount }],
  };
}

describe('chat actions: a wrong date is easy to spot', () => {
  it('says when the same trek also runs on other dates, on bookings and payments', async () => {
    const h = new Harness();
    h.treks.upsert(makeTrek({ name: 'gorkhey – samanden', durationDays: 4, startDate: start(50), pricePerPerson: 9500, seatsLeft: 9, seatCapacity: 9 }));
    h.next = [bookingCall({ amount_received: undefined, payment_mode: undefined })];
    const chat = h.chat();
    await chat.send('Book on Gorkhey', NOW);
    const v = chat.viewDraft(chat.messages[1].drafts![0], NOW)!;
    expect(v.sums.some((x) => x.startsWith('Other dates for this trek: ') && x.includes('Dec 2026'))).toBe(true);
    // a trek that runs once says nothing
    const solo = new Harness();
    solo.next = [bookingCall({ amount_received: undefined, payment_mode: undefined })];
    const c2 = solo.chat();
    await c2.send('Book on Gorkhey', NOW);
    expect(c2.viewDraft(c2.messages[1].drafts![0], NOW)!.sums.some((x) => x.startsWith('Other dates'))).toBe(false);
  });
});
