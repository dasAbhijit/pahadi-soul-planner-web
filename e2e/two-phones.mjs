import { launch } from './cdp.mjs';
import { ensurePreview } from './preview.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('e2e/out', { recursive: true });
const stopPreview = await ensurePreview();
import { createRequire } from 'node:module';
const { makeEnv } = createRequire(import.meta.url)('./fake-script.cjs');
const env = makeEnv('s3cret-s3cret-s3cret');
const ADDR = 'https://script.google.com/macros/s/FAKE/exec';
const URL = 'http://localhost:4173/';
const seen = [];
const step = (m) => console.log('•', m);
const fail = (m) => { console.log('✗ FAIL:', m); process.exitCode = 1; };
const expect = (cond, m) => (cond ? console.log('  ✓', m) : fail(m));

async function phone(name, port) {
  const b = await launch({ url: URL, out: 'e2e/out', port });
  await b.fakeGoogle(env.call, seen);
  b.name = name;
  return b;
}

const URLX = URL;
async function fill(b, label, value, nth = 0) {
  const ok = await b.ev(`(()=>{const ls=[...document.querySelectorAll('label.field')].filter(l=>l.innerText.split('\\n')[0].trim().startsWith(${JSON.stringify(label)}));const el=ls[${nth}]?.querySelector('input,textarea');if(!el)return false;el.scrollIntoView({block:'center'});el.focus();if(el.select)el.select();return true})()`);
  if (!ok) throw new Error('no field ' + label);
  await b.send('Input.insertText', { text: value }); await b.sleep(100);
}
async function setDate(b, label, ymd) {
  await b.ev(`(()=>{const l=[...document.querySelectorAll('label.field')].find(l=>l.innerText.split('\\n')[0].trim().startsWith(${JSON.stringify(label)}));const el=l.querySelector('input[type=date]');el.value=${JSON.stringify(ymd)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await b.sleep(150);
}
const body = async (b) => (await b.text()).replace(/\s+/g, ' ');
const syncNow = async (b) => { await b.go(URLX + '#/settings'); await b.sleep(200); await b.click('Sync now'); await b.sleep(1100); return (await b.ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(c=>c.innerText.includes('Sync now'));return c?c.innerText:''})()`)).replace(/\s+/g,' '); };

const A = await phone('Asha', 9351);
const B = await phone('Meera', 9352);
const C = await phone('Rohit', 9353);
try {
  step('Asha sets up the first Owner on the new sheet');
  await A.go(URLX + '#/first-owner'); await A.sleep(300);
  expect(/Set up the first Owner/.test(await body(A)), 'a signed-out phone shows the first-Owner screen');
  await fill(A, 'Web app address', ADDR); await fill(A, 'Setup code', 's3cret-s3cret-s3cret'); await fill(A, 'Your name', 'Asha Rao');
  await fill(A, 'Choose a password', 'owner-pass-123'); await fill(A, 'Repeat the password', 'owner-pass-123');
  await A.click('Create Owner account'); await A.sleep(1500);
  { const t0 = await body(A); expect(/Chat/.test(t0) && !/Set up the first Owner/.test(t0), 'Asha is in the app after creating the Owner'); }
  await A.go(URLX + '#/settings'); await A.sleep(300);
  { const t0 = await body(A); expect(/Asha Rao/.test(t0) && /OWNER/.test(t0), 'Settings shows Asha Rao as Owner'); expect(/People/.test(t0), 'Owner sees the People card'); }

  const invite = async (name, role) => {
    await A.go(URLX + '#/invite'); await A.sleep(300);
    await fill(A, 'Name', name);
    await A.click(role, '.seg button');
    await A.click('Create invite'); await A.sleep(900);
    return A.ev(`document.querySelector('[data-testid=invite-text]')?.innerText || ''`);
  };
  const join = async (b, text, pw) => {
    await b.go(URLX + '#/join'); await b.sleep(300);
    await fill(b, 'Invite', text); await b.sleep(900);
    await fill(b, 'Choose a password', pw); await fill(b, 'Repeat the password', pw);
    const preview = await body(b);
    await b.click('Join', 'button.btn'); await b.sleep(1500);
    return preview;
  };

  step('Asha invites Meera (Manager) and Rohit (Staff); they join with the invite text');
  const invM = await invite('Meera Paul', 'Manager');
  expect(/^PSP1\./.test(invM), 'the invite text carries the sheet address and a code');
  const pm = await join(B, invM, 'meera-pass-123');
  expect(/Meera Paul/.test(pm) && /Invited by Asha Rao/.test(pm), 'Join shows who the invite is for before the password is chosen');
  const invR = await invite('Rohit Sharma', 'Staff');
  await join(C, invR, 'rohit-pass-123');
  for (const [b, who, role] of [[B, 'Meera Paul', 'MANAGER'], [C, 'Rohit Sharma', 'STAFF']]) {
    await b.go(URLX + '#/settings'); await b.sleep(300);
    const t0 = await body(b);
    expect(t0.includes(who) && t0.includes(role), `${who} is signed in as ${role}`);
  }
  expect(!/People/.test((await body(C)).replace(/Sign out[^]*/, '')) , 'Staff does not see the People card');
  await join(B, invM, 'x').catch(() => {});
  console.log('  (an invite works once: reusing it is refused by the script, covered by cloud/test-people.js)');

  step('Asha adds Kuari Pass (10 Mar 2027, 8 seats, Rs 14,500) and syncs');
  await A.go(URLX + '#/edit-trek/new'); await A.sleep(300);
  await fill(A, 'Trek name', 'Kuari Pass'); await fill(A, 'Price per person', '14500');
  await A.click('Fixed start date'); await setDate(A, 'Start date', '2027-03-10'); await fill(A, 'Seats left', '8');
  await A.click('Save'); await A.sleep(400);
  await A.go(URLX + '#/treks'); await A.sleep(300);
  expect(/Kuari Pass/.test(await body(A)), 'trek saved and shown');
  let r = await syncNow(A);
  console.log('  A sync says:', (r.match(/Synced[^.]*\.|Everything[^.]*\./) || [r.slice(0, 200)])[0]);
  expect((env.sheets.Treks?.grid.length || 0) === 2, `sheet Treks tab: header + 1 row (${env.sheets.Treks?.grid.length})`);

  step('Meera syncs and gets the trek');
  r = await syncNow(B);
  await B.go(URLX + '#/treks'); await B.sleep(300);
  { const t = await body(B); expect(/Kuari Pass/.test(t), 'Meera sees Kuari Pass after syncing'); console.log('  list text:', t.slice(0, 200)); }

  step('both phones book at the same time, before either syncs');
  const bookTrek = async (b, travellers, phoneNo, received) => {
    await b.go(URLX + '#/treks'); await b.click('Kuari Pass'); await b.sleep(300);
    await b.click('Add booking'); await b.sleep(300);
    if (travellers.length === 1) await b.click('−');
    await fill(b, 'Traveller 1', travellers[0]);
    if (travellers[1]) await fill(b, 'Traveller 2', travellers[1]);
    await fill(b, 'Contact number', phoneNo);
    if (received) await fill(b, 'Received now', String(received));
    await b.click('Confirm'); await b.sleep(500);
    return body(b);
  };
  let t1 = await bookTrek(A, ['Asha Rao'], '9800000001');
  console.log('  A after booking ->', t1.slice(0, 150));
  let t2 = await bookTrek(B, ['Rina Das', 'Tuhin Das'], '9800000002', 5000);
  console.log('  B after booking ->', t2.slice(0, 150));

  step('Asha syncs, then Meera syncs (merge), then Asha again');
  r = await syncNow(A); console.log('  A:', r.match(/Synced[^.]*\.|Everything[^.]*\.|[^/]*sheet[^/]*/i)?.[0]);
  r = await syncNow(B); console.log('  B:', r.match(/Synced[^.]*\.|Everything[^.]*\./)?.[0] || r.slice(0, 200));
  r = await syncNow(A); console.log('  A:', r.match(/Synced[^.]*\.|Everything[^.]*\./)?.[0] || r.slice(0, 200));
  for (const [b, who] of [[A, 'Asha'], [B, 'Meera']]) {
    await b.go(URLX + '#/treks'); await b.sleep(300);
    const t = await body(b);
    await b.click('Kuari Pass'); await b.sleep(300);
    const d = await body(b);
    expect(/SEATS LEFT 5/.test(d), `${who}: trek page says SEATS LEFT 5 (8 minus 1 minus 2)  → ${(d.match(/SEATS LEFT \d+/)||['?'])[0]}`);
    expect(/Asha Rao/.test(d) && /Rina Das/.test(d), `${who}: trek page lists both bookings`);
    expect(/5,000/.test(d), `${who}: shows the ₹5,000 received`);
  }
  expect(env.sheets.Bookings.grid.length === 3, `sheet Bookings tab: header + 2 rows (${env.sheets.Bookings.grid.length})`);
  expect(env.sheets.Money.grid.length === 2, `sheet Money tab: header + 1 row (${env.sheets.Money.grid.length})`);
  expect(env.sheets.Bookings.grid[0].slice(-2).join() === 'Added by,Last changed by' && env.sheets.Bookings.grid[1].slice(-2).every(Boolean), 'the sheet names who added and last changed each booking: ' + env.sheets.Bookings.grid.slice(1).map(r => r.slice(-2).join('/')).join(' ; '));

  step('both record the same Rs 3,000 from Rina on the same day (a double entry)');
  const addMoney = async (b) => {
    await b.go(URLX + '#/entry?kind=in'); await b.sleep(300);
    await fill(b, 'Amount', '3000');
    await b.click('Kuari Pass', 'button.choice'); await b.sleep(150); await b.ev(`(()=>{const sel=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.text.includes('Rina')));const o=[...sel.options].find(o=>o.text.includes('Rina'));sel.value=o.value;sel.dispatchEvent(new Event('change',{bubbles:true}));})()`); await b.sleep(150);
    await b.click('Save'); await b.sleep(500);
    return body(b);
  };
  console.log('  A saved ->', (await addMoney(A)).slice(0, 110));
  console.log('  B saved ->', (await addMoney(B)).slice(0, 110));
  await syncNow(A); await syncNow(B); const ra = await syncNow(A);
  for (const [b, who] of [[A, 'Asha'], [B, 'Meera']]) {
    await b.go(URLX + '#/money'); await b.sleep(400);
    const t = await body(b);
    expect(/duplicate/i.test(t), `${who}: Money tab shows a possible-duplicates banner  → ${(t.match(/[^.]*duplicate[^.]*/i)||[''])[0].slice(0,90)}`);
    expect(/FUND BALANCE ₹11,000/.test(t) || /₹11,000/.test(t), `${who}: fund balance counts all three payments (5,000 + 3,000 + 3,000 = 11,000)  → ${(t.match(/FUND BALANCE ₹[\d,]+/)||['?'])[0]}`);
  }
  step('Asha reviews the duplicate: Keep all');
  await A.go(URLX + '#/duplicates'); await A.sleep(300);
  console.log('  review screen:', (await body(A)).slice(0, 160));
  await A.click('Keep all'); await A.sleep(400);
  await A.go(URLX + '#/money'); await A.sleep(300);
  expect(!/duplicate/i.test(await body(A)), 'Asha: banner gone after Keep all (nothing deleted)');
  await B.go(URLX + '#/money'); await B.sleep(300);
  expect(/duplicate/i.test(await body(B)), "Meera: still sees the banner (Keep all is per phone)");

  step('Meera deletes one of the two, syncs; Asha syncs');
  await B.go(URLX + '#/duplicates'); await B.sleep(300);
  await B.click('Delete'); await B.sleep(300); await B.click('Delete', '.dialog button'); await B.sleep(400);
  await syncNow(B); await syncNow(A);
  await A.go(URLX + '#/money'); await A.sleep(300);
  const ta = await body(A);
  expect(/FUND BALANCE ₹8,000/.test(ta), `Asha: after Meera's delete, balance is 8,000  → ${(ta.match(/FUND BALANCE ₹[\d,]+/)||['?'])[0]}`);
  expect(env.sheets.Money.grid.slice(1).filter(r => r[r.length - 4] !== '').length === 1, 'sheet keeps the deleted entry as a tombstone (1 row with Deleted at filled)');
  step('Rohit (Staff) syncs and sees only what a Staff person may');
  await syncNow(C);
  await C.go(URLX + '#/money'); await C.sleep(400);
  { const t = await body(C);
    expect(/payments you can see/i.test(t), 'Staff Money tab is the payments-received list');
    expect(!/fund balance|Filters/i.test(t) && !/Out ₹/.test(t), 'no fund balance, filters or money-out totals for Staff');
    expect(/by Asha|by Meera/.test(t), 'rows say who recorded them (' + (t.match(/by \w+/g) || []).join(', ') + ')'); }
  await C.go(URLX + '#/settings'); await C.sleep(300);
  { const t = await body(C); expect(!/Export all data|Restore|Assistant prompt|Model/.test(t), 'Staff Settings has no export, restore, model or prompt'); }
  step('Rohit records a payment; Asha sees it with his name');
  await C.go(URLX + '#/entry?kind=in'); await C.sleep(300);
  expect(!/Money out/.test(await body(C)), 'the entry form for Staff has no Money out choice');
  await fill(C, 'Amount', '1500');
  await C.click('Kuari Pass', 'button.choice'); await C.sleep(150);
  await C.ev(`(()=>{const sel=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.text.includes('Asha')));const o=[...sel.options].find(o=>o.text.includes('Asha'));sel.value=o.value;sel.dispatchEvent(new Event('change',{bubbles:true}));})()`); await C.sleep(150);
  await C.click('Save'); await C.sleep(500);
  { const r = await syncNow(C); console.log('  Rohit sync:', (r.match(/Synced[^.]*\.|Everything[^.]*\./) || [r.slice(0, 160)])[0]); }
  await syncNow(A);
  await A.go(URLX + '#/money'); await A.sleep(400);
  { const t = await body(A); expect(/by Rohit/.test(t), 'Asha sees "by Rohit" on the payment Rohit recorded'); expect(/₹1,500/.test(t), 'and the amount'); }

  step('Asha removes Rohit; Rohit\'s phone is cleared at its next sync');
  await A.go(URLX + '#/people'); await A.sleep(900);
  expect(/Rohit Sharma/.test(await body(A)) && /Meera Paul/.test(await body(A)), 'People lists everyone');
  await A.click('Rohit Sharma'); await A.sleep(900);
  await A.click('Remove access'); await A.sleep(300); await A.click('Remove access', '.dialog button'); await A.sleep(900);
  expect(/Access removed/.test(await body(A)), 'Rohit shows as removed');
  await syncNow(C).catch(() => {}); await C.sleep(800);
  { const t = await body(C); expect(/Your access was removed/.test(t), 'Rohit sees the access-removed screen'); }
  { const left = await C.ev(`JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('pahadi.')).map(k=>[k,localStorage.getItem(k).length]))`);
    const treks = JSON.parse(await C.ev(`localStorage.getItem('pahadi.treks')||'[]'`)); expect(treks.length === 0, 'Rohit\'s phone holds no treks any more'); 
    expect(!(await C.ev(`localStorage.getItem('pahadi.secret.session')`)), 'and no session code'); console.log('  keys left:', left); }
  await C.shot('e2e-C-removed');
  console.log('  requests seen by the fake script:', JSON.stringify(seen.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})));
  console.log('  page errors A/B:', JSON.stringify(A.errors), JSON.stringify(B.errors), ' console:', JSON.stringify(A.logs), JSON.stringify(B.logs));
  await A.shot('e2e-A-money'); await B.shot('e2e-B-money');
  await A.close(); await B.close(); await C.close(); stopPreview(); process.exit(process.exitCode || 0);
} catch (e) { console.log('ERROR', e.message); console.log('A', A.errors, A.logs, 'B', B.errors, B.logs, 'C', C.errors, C.logs); await A.close(); await B.close(); await C.close(); stopPreview(); process.exit(1); }
