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
async function setupSync(b, who) {
  await b.go(URL + '#/settings'); await b.sleep(300);
  // name field in the Cloud sync card
  await b.ev(`(()=>{const el=[...document.querySelectorAll('input')].find(i=>/^Your name/i.test(i.closest('label')?.innerText||''));el.scrollIntoView();el.focus();el.select&&el.select();})()`);
  await b.send('Input.insertText', { text: who }); await b.sleep(150);
  await b.go(URL + '#/cloud-setup'); await b.sleep(300);
  await b.type('input,textarea', ADDR, 0);
  await b.type('input[type=password]', 's3cret-s3cret-s3cret', 0);
  await b.click('Save'); await b.click('Test connection'); await b.sleep(1200);
  return (await b.text()).replace(/\s+/g, ' ');
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
const syncNow = async (b) => { await b.go(URLX + '#/settings'); await b.sleep(200); await b.click('Sync to cloud'); await b.sleep(1100); return (await b.ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(c=>c.innerText.includes('Sync to cloud'));return c?c.innerText:''})()`)).replace(/\s+/g,' '); };

const A = await phone('Asha', 9351);
const B = await phone('Meera', 9352);
try {
  step('both phones connect to the same sheet');
  for (const [b, who] of [[A, 'Asha'], [B, 'Meera']]) {
    const t = await setupSync(b, who);
    expect(/Connected to/i.test(t), `${who}: connected` + (/Connected to/i.test(t) ? '' : ' :: ' + t.slice(0, 250)));
  }

  step('Asha adds Kuari Pass (10 Mar 2027, 8 seats, Rs 14,500) and syncs');
  await A.go(URLX + '#/edit-trek/new'); await A.sleep(300);
  await fill(A, 'Trek name', 'Kuari Pass'); await fill(A, 'Price per person', '14500');
  await A.click('Fixed start date'); await setDate(A, 'Start date', '2027-03-10'); await fill(A, 'Seats left', '8');
  await A.click('Save'); await A.sleep(400);
  await A.go(URLX + '#/treks'); await A.sleep(300);
  expect(/Kuari Pass/.test(await body(A)), 'trek saved and shown');
  let r = await syncNow(A);
  console.log('  A sync says:', (r.match(/Synced[^.]*\.|Everything[^.]*\./) || [r.slice(0, 200)])[0]);
  expect((env.sheets.Treks?.grid.length || 0) >= 3, `sheet Treks tab has rows (${env.sheets.Treks?.grid.length})`);

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
  expect(env.sheets.Money.grid.slice(1).filter(r => r[r.length - 2] !== '').length === 1, 'sheet keeps the deleted entry as a tombstone (1 row with Deleted at filled)');
  console.log('  requests seen by the fake script:', JSON.stringify(seen.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})));
  console.log('  page errors A/B:', JSON.stringify(A.errors), JSON.stringify(B.errors), ' console:', JSON.stringify(A.logs), JSON.stringify(B.logs));
  await A.shot('e2e-A-money'); await B.shot('e2e-B-money');
  await A.close(); await B.close(); stopPreview(); process.exit(process.exitCode || 0);
} catch (e) { console.log('ERROR', e.message); console.log('A', A.errors, A.logs, 'B', B.errors, B.logs); await A.close(); await B.close(); stopPreview(); process.exit(1); }
