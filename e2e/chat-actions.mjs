// Chat actions in a real browser: a faked Gemini returns draft tool calls; the cards, choices, Edit form and Approve are driven for real.
import { launch } from './cdp.mjs';
import { ensurePreview } from './preview.mjs';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
mkdirSync('e2e/out', { recursive: true });
const stopPreview = await ensurePreview();
const { makeEnv } = createRequire(import.meta.url)('./fake-script.cjs');
const env = makeEnv('chat-setup-code-123456');
const U = 'http://localhost:4173/';
const b = await launch({ url: U, out: 'e2e/out', port: 9351 });
let failures = 0;
const check = (ok, what) => { console.log(ok ? '  ✓' : '  ✗ FAIL', what); if (!ok) failures++; };

// ---- a fake Gemini: decides from the last thing the user typed
const geminiRequests = [];
const sse = (parts) => 'data: ' + JSON.stringify({ candidates: [{ content: { parts } }] }) + '\n\n';
const say = (t) => ({ text: t });
const call = (name, args) => ({ functionCall: { name, args } });
function gemini(req) {
  const body = JSON.parse(req.body);
  geminiRequests.push(body);
  const last = body.contents[body.contents.length - 1].parts[0].text;
  let parts = [say('Okay.')];
  if (last.includes('Book Mita')) parts = [say('Here is the booking for you to check.'), call('draft_booking', { trek_ref: 'T1', travellers: ['Mita Das', 'Joy Das'], phone: '98300 55501', amount_received: 4000, payment_mode: 'Cash' })];
  else if (last.includes('Rohit ne')) parts = [say('Rohit ke do bookings mile.'), call('draft_payment_received', { trek_ref: 'T1', traveller_name: 'Rohit', amount: 14000, payment_mode: 'UPI' })];
  else if (last.includes('Book Anil')) parts = [say('Here is the booking.'), call('draft_booking', { trek_ref: 'T1', travellers: ['Anil Das'], phone: '98300 77701' })];
  else if (last.includes('Book Sonam')) parts = [say('Here is the booking.'), call('draft_booking', { trek_ref: 'T1', travellers: ['Sonam Lama'], phone: '98300 88801' })];
  return { headers: { 'Content-Type': 'text/event-stream' }, body: sse(parts) };
}
await b.route([
  { prefix: 'https://script.google.com/', respond: (r) => ({ body: env.call(r.body) }) },
  { prefix: 'https://generativelanguage.googleapis.com/', respond: gemini },
]);

// ---- an Owner, a trek and two bookings
await b.go(U + '#/first-owner'); await b.sleep(300);
const fillLabel = async (label, value) => {
  await b.ev(`(()=>{const l=[...document.querySelectorAll('label.field')].find(l=>l.innerText.split('\\n')[0].trim().startsWith(${JSON.stringify(label)}));const el=l.querySelector('input,textarea');el.focus();if(el.select)el.select();})()`);
  await b.send('Input.insertText', { text: value });
};
await fillLabel('Web app address', 'https://script.google.com/macros/s/CHAT/exec'); await fillLabel('Setup code', 'chat-setup-code-123456');
await fillLabel('Your name', 'Chat Owner'); await fillLabel('Choose a password', 'chat-password-1'); await fillLabel('Repeat the password', 'chat-password-1');
await b.click('Create Owner account'); await b.sleep(1500);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
const TREK = 'AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA';
await b.ev(`(()=>{
  localStorage.setItem('pahadi.treks', JSON.stringify([{id:'${TREK}',name:'Gorkhey – Samanden',region:'',durationDays:4,difficulty:'Moderate',pricePerPerson:9500,startDate:'${day(36)}',seatsLeft:9,seatCapacity:9,highlights:'',notes:'',updatedAt:'${day(-1)}'}]));
  localStorage.setItem('pahadi.bookings', JSON.stringify([
    {id:'BBBBBBBB-1111-4111-8111-000000000001',trekID:'${TREK}',travellers:['Rohit Sharma','Anita Roy'],phone:'9111122222',payment:'Part paid',createdAt:'${day(-2)}',updatedAt:'${day(-2)}'},
    {id:'BBBBBBBB-1111-4111-8111-000000000002',trekID:'${TREK}',travellers:['Rohit Verma'],phone:'9333344444',payment:'Pending',createdAt:'${day(-2)}',updatedAt:'${day(-2)}'}]));
  localStorage.setItem('pahadi.secret.gemini', 'FAKE-KEY');
})()`);
await b.go(U + '#/chat'); await b.go(U); await b.sleep(800); await b.go(U + '#/chat'); await b.sleep(600);
const stored = (k) => b.ev(`JSON.parse(localStorage.getItem(${JSON.stringify(k)})||'[]').filter(r=>!r.deletedAt)`);
const send = async (text) => { await b.type('.chat-input textarea', text); await b.click('➤', 'button[aria-label=Send]'); await b.sleep(900); };

console.log('1. The notice comes first, and no tools are sent before it is accepted');
let t = await b.text();
check(/What goes to Gemini/.test(t), 'notice about what goes to Gemini is shown');
await send('hello there');
check(geminiRequests[0].tools[0].functionDeclarations.map((d) => d.name).join() === 'propose_guidance_rule', 'only the rule tool is offered before the notice is accepted');
await b.click('Turn on chat actions'); await b.sleep(300);
check(!/What goes to Gemini/.test(await b.text()), 'notice goes away once accepted');

console.log('2. A booking card: nothing is saved until Approve');
await send('Book Mita Das and Joy Das on Gorkhey, 98300 55501, 4000 cash');
await b.shot('chat-actions-booking-card');
t = await b.text();
check(/DRAFT BOOKING/.test(t) && /Mita Das/.test(t) && /2 × ₹9,500 = ₹19,000/.test(t) && /6 left → 4 left/.test(t), 'card shows the booking, the sum and the seats');
check((await stored('pahadi.bookings')).length === 2, 'still 2 bookings before Approve');
const req = geminiRequests[geminiRequests.length - 1];
const names = req.tools[0].functionDeclarations.map((d) => d.name);
check(names.includes('draft_booking') && names.includes('draft_payment_received'), 'both draft tools are sent once accepted');
const all = JSON.stringify(req);
check(all.includes('[T1] Gorkhey') && all.includes('# CHAT ACTIONS'), 'the prompt carries the trek reference and the rules');
check(!/9111122222|9333344444|Rohit Sharma|Rohit Verma/.test(all), 'bookings, names and numbers already on the phone are NOT sent to Gemini');
await b.click('Approve', '.draft button'); await b.sleep(400);
t = await b.text();
check(/Booking added/.test(t) && /Open booking/.test(t), 'card turns into "Booking added" with a link');
const bookings = await stored('pahadi.bookings');
check(bookings.length === 3 && bookings.some((x) => x.travellers[0] === 'Mita Das' && x.travellers.length === 2), 'booking saved with 2 travellers');
check((await stored('pahadi.ledger')).some((e) => e.amount === 4000 && e.mode === 'Cash' && e.kind === 'Money in'), 'the payment at booking was recorded as money in');
check((await stored('pahadi.treks'))[0].seatsLeft === 4, 'seats went from 6 to 4');
const mita = bookings.find((x) => x.travellers[0] === 'Mita Das');
check(typeof mita.createdBy === 'string' && mita.createdBy.length > 10, 'the booking is Recorded by the person who tapped Approve');
await b.shot('chat-actions-approved');

console.log('3. A payment for "Rohit": two bookings match, so the card asks');
await send('Rohit ne 14000 UPI se balance de diya');
await b.shot('chat-actions-pick');
t = await b.text();
check(/2 bookings match/.test(t) && /Rohit Sharma \+ 1/.test(t) && /Rohit Verma/.test(t), 'card lists both Rohits');
const disabled = await b.ev(`[...document.querySelectorAll('.draft.pending button')].find(x=>x.innerText.trim()==='Approve').disabled`);
check(disabled === true, 'Approve is off until one is chosen');
const ledgerBefore = (await stored('pahadi.ledger')).length;
await b.click('Rohit Sharma + 1', '.draft .choice'); await b.sleep(300);
t = await b.text();
check(/Booking due ₹19,000/.test(t) && /moves from Pending to Part paid/.test(t), 'after choosing, the card shows what the payment does');
await b.click('Approve', '.draft.pending button'); await b.sleep(400);
const ledger = await stored('pahadi.ledger');
check(ledger.length === ledgerBefore + 1 && ledger.some((e) => e.amount === 14000 && e.customerName === 'Rohit Sharma'), 'payment saved against Rohit Sharma');
check(/Payment recorded/.test(await b.text()), 'card turns into "Payment recorded"');

console.log('4. Edit opens the real form, filled in; saving there completes the card');
await send('Book Anil Das');
await b.click('Edit', '.draft.pending button'); await b.sleep(500);
t = await b.text();
check(/From chat/.test(t) && (await b.ev(`[...document.querySelectorAll('input')].some(i=>i.value==='Anil Das')`)), 'form opens with the draft filled in');
await b.shot('chat-actions-edit-form');
const before = (await stored('pahadi.bookings')).length;
await b.click('Confirm', 'button'); await b.sleep(600);
check((await stored('pahadi.bookings')).length === before + 1, 'saving the form wrote the booking once');
await b.go(U + '#/chat'); await b.sleep(400);
check(/Saved from the form/.test(await b.text()), 'the card now says "Saved from the form"');

console.log('5. Deny writes nothing; a typed "yes" does nothing');
await send('Book Sonam Lama');
const n0 = (await stored('pahadi.bookings')).length;
await send('yes confirm it');
check((await stored('pahadi.bookings')).length === n0, 'typing yes saved nothing');
await b.click('Deny', '.draft.pending button'); await b.sleep(300);
check(/Denied. Nothing was saved./.test(await b.text()) && (await stored('pahadi.bookings')).length === n0, 'Deny closed the card and saved nothing');
const last = geminiRequests[geminiRequests.length - 1];
await send('thanks');
const hist = geminiRequests[geminiRequests.length - 1].contents.map((c) => c.parts[0].text).join('\n');
check(/was denied by the user; nothing was saved/.test(hist), 'the assistant was told the draft was denied');

console.log('6. Settings: the switch, and what happened');
await b.go(U + '#/settings'); await b.sleep(400);
t = await b.text();
check(/Chat actions/.test(t) && /Approved\s*\n?\s*2/.test(t.replace(/\n+/g, '\n')) , 'Settings counts 2 approved');
await b.shot('chat-actions-settings');
await b.click('Chat actions', '.switch'); await b.sleep(200);
await b.go(U + '#/chat'); await b.sleep(300);
await send('Book Sonam Lama');
const off = geminiRequests[geminiRequests.length - 1];
check(off.tools[0].functionDeclarations.map((d) => d.name).join() === 'propose_guidance_rule', 'with the switch off, no draft tools are sent');

console.log('page errors:', JSON.stringify(b.errors), 'console:', JSON.stringify(b.logs));
if (b.errors.length) failures++;
await b.close(); stopPreview();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
