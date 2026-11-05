import './helpers';
import { describe, expect, it } from 'vitest';
import { Chat, DRAFT_INTRO, type ChatActionDeps } from '../src/core/chat';
import { MAX_DRAFTS_PER_REPLY, TOOL_BOOKING, TOOL_PAYMENT_IN, draftFromCall, matchBookings, toolDeclarations, trekRefs } from '../src/core/chatactions';
import { makeStreamRequest, parseSSELine, type GeminiEvent, type GeminiMessage } from '../src/core/gemini';
import { buildPrompt } from '../src/core/prompt';
import { Secrets, SettingsStore } from '../src/core/settings';
import { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from '../src/core/stores';
import { MemoryKV } from '../src/core/storage';
import { makeBooking, makeTrek, type Trek } from '../src/core/models';
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
    expect(d.data.trekID).toBeUndefined();
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
    const refs = trekRefs([makeTrek({ name: 'X', startDate: start(10) })], NOW);
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
    for (const role of ['Staff', 'Manager', 'Owner'] as const) expect(toolDeclarations(role).map((t) => t.name)).toEqual([TOOL_BOOKING, TOOL_PAYMENT_IN]);
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
