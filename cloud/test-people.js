// Tests for the people, sign-in, roles and per-record merge in Code.gs (version 2).
// Runs the real script against a fake of Google's classes. Usage: node cloud/test-people.js
const assert = require('assert');
const { makeEnv } = require('./fake-google');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }

const DAY = 86400000;
const SETUP = 'setup-secret-0123456789';
const PASSWORD = 'correct horse battery';

const treksH = ['Trek ID', 'Name', 'Updated at', 'Deleted at', 'Record (JSON)'];
const bookingsH = ['Booking ID', 'Contact', 'Updated at', 'Deleted at', 'Record (JSON)'];
const moneyH = ['Entry ID', 'Type', 'Amount (INR)', 'Updated at', 'Deleted at', 'Record (JSON)'];
const vendorsH = ['Vendor ID', 'Name', 'Updated at', 'Deleted at', 'Record (JSON)'];
const guidanceH = ['Rule ID', 'Rule', 'Updated at', 'Deleted at', 'Record (JSON)'];

const at = (n) => new Date(Date.parse('2026-11-01T00:00:00Z') + n * 60000).toISOString().replace('.000Z', 'Z');
const json = (o) => JSON.stringify(o);
const trek = (id, name, n, extra) => ({ id, name, updatedAt: at(n), ...extra });
const trekRow = (o) => [o.id, o.name, o.updatedAt || '', o.deletedAt || '', json(o)];
const bookingRow = (o) => [o.id, (o.travellers || [''])[0], o.updatedAt || '', o.deletedAt || '', json(o)];
const moneyRow = (o) => [o.id, o.kind, o.amount, o.updatedAt || '', o.deletedAt || '', json(o)];
const vendorRow = (o) => [o.id, o.name, o.updatedAt || '', o.deletedAt || '', json(o)];
const ruleRow = (o) => [o.id, o.text, o.updatedAt || '', o.deletedAt || '', json(o)];
const table = (name, headers, rows) => ({ name, headers, rows });

function fresh() {
  const env = makeEnv(SETUP);
  const owner = env.call({ action: 'setupOwner', token: SETUP, name: 'Abhijit Das', password: PASSWORD, device: 'Web' });
  assert.strictEqual(owner.ok, true, JSON.stringify(owner));
  env.ownerSession = owner.session;
  env.ownerId = owner.person.id;
  return env;
}

/** Owner invites a person and the person joins. Returns { session, id }. */
function addPerson(env, name, role, password = 'tashi-password-1') {
  const inv = env.call({ action: 'invite', session: env.ownerSession, name, role });
  assert.strictEqual(inv.ok, true, JSON.stringify(inv));
  const j = env.call({ action: 'join', invite: inv.code, password, device: 'Android' });
  assert.strictEqual(j.ok, true, JSON.stringify(j));
  return { session: j.session, id: j.person.id, name, password };
}

const push = (env, session, tables) => env.call({ action: 'push', session, device: 'Web', tables });
const pull = (env, session) => env.call({ action: 'pull', session, device: 'Web' });
const lines = (r, tab) => r.tables[tab].map((l) => JSON.parse(l));
const byId = (list, id) => list.find((x) => x.id === id);

// ------------------------------------------------------------------ Status and first Owner

test('status needs no secret and says whether the first Owner is still to be created', () => {
  const env = makeEnv(SETUP);
  assert.deepStrictEqual(env.call({ action: 'status' }), { ok: true, v: 2, setupNeeded: true });
  env.call({ action: 'setupOwner', token: SETUP, name: 'Abhijit Das', password: PASSWORD });
  assert.deepStrictEqual(env.call({ action: 'status' }), { ok: true, v: 2, setupNeeded: false });
});

test('before the first Owner, sign-in actions are refused and the old protocol still works', () => {
  const env = makeEnv(SETUP);
  assert.strictEqual(env.call({ action: 'signIn', name: 'x', password: 'whatever12' }).code, 'notSetUp');
  assert.strictEqual(env.call({ action: 'pull', session: 'abc' }).code, 'notSetUp');
  assert.strictEqual(env.call({ token: SETUP, action: 'ping' }).ok, true);
});

test('first Owner: wrong setup code, weak password and short name are refused and create nobody', () => {
  const env = makeEnv(SETUP);
  assert.strictEqual(env.call({ action: 'setupOwner', token: 'nope', name: 'Abhijit', password: PASSWORD }).code, 'badSetup');
  assert.strictEqual(env.call({ action: 'setupOwner', name: 'Abhijit', password: PASSWORD }).code, 'badSetup');
  assert.match(env.call({ action: 'setupOwner', token: SETUP, name: 'Abhijit', password: 'short' }).error, /8 characters/);
  assert.match(env.call({ action: 'setupOwner', token: SETUP, name: 'A', password: PASSWORD }).error, /name/);
  assert.strictEqual(env.call({ action: 'status' }).setupNeeded, true);
  assert.strictEqual(Object.keys(env.props).filter((k) => k.startsWith('person:')).length, 0);
});

test('first Owner: setup code can only be tried 20 times, then 15 minutes lock', () => {
  const env = makeEnv(SETUP);
  for (let i = 0; i < 20; i++) env.call({ action: 'setupOwner', token: 'wrong' + i, name: 'Abhijit', password: PASSWORD });
  assert.strictEqual(env.call({ action: 'setupOwner', token: SETUP, name: 'Abhijit', password: PASSWORD }).code, 'locked');
  env.advance(16 * 60000);
  assert.strictEqual(env.call({ action: 'setupOwner', token: SETUP, name: 'Abhijit', password: PASSWORD }).ok, true);
});

test('first Owner is created once; then the setup code stops working for everything', () => {
  const env = fresh();
  assert.strictEqual(env.call({ action: 'setupOwner', token: SETUP, name: 'Second', password: PASSWORD }).code, 'setupDone');
  assert.strictEqual(env.call({ token: SETUP, action: 'pull' }).code, 'updateApp');
  assert.strictEqual(env.call({ token: SETUP, action: 'ping' }).code, 'updateApp');
  assert.strictEqual(env.call({ token: SETUP, action: 'push', baseVersion: 0, tables: [] }).code, 'updateApp');
  assert.match(env.call({ token: SETUP, action: 'pull' }).error, /Update the app/);
});

test('passwords, session codes and invite codes are never stored as plain text', () => {
  const env = fresh();
  const t = addPerson(env, 'Tashi Sherpa', 'Staff', 'tashi-password-1');
  const stored = JSON.stringify(env.props);
  assert.ok(!stored.includes(PASSWORD));
  assert.ok(!stored.includes('tashi-password-1'));
  assert.ok(!stored.includes(env.ownerSession));
  assert.ok(!stored.includes(t.session));
  assert.ok(Object.keys(env.props).every((k) => !k.includes(t.session)));
});

// ------------------------------------------------------------------ Sign-in

test('sign in: right password gives a session and the people directory; the name is not case sensitive', () => {
  const env = fresh();
  const r = env.call({ action: 'signIn', name: '  abhijit   DAS ', password: PASSWORD, device: 'iPhone' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.person, { id: env.ownerId, name: 'Abhijit Das', role: 'Owner' });
  assert.strictEqual(r.spreadsheet, 'Pahadi Soul Planner App');
  assert.deepStrictEqual(r.directory, [{ id: env.ownerId, name: 'Abhijit Das' }]);
  assert.strictEqual(pull(env, r.session).ok, true);
});

test('sign in: wrong password and unknown name look the same and count down the tries', () => {
  const env = fresh();
  const a = env.call({ action: 'signIn', name: 'Abhijit Das', password: 'wrong-password' });
  const b = env.call({ action: 'signIn', name: 'Nobody Here', password: 'wrong-password' });
  assert.deepStrictEqual([a.code, a.error], ['badLogin', 'Wrong name or password.']);
  assert.deepStrictEqual([b.code, b.error], ['badLogin', 'Wrong name or password.']);
  assert.strictEqual(a.triesLeft, 4);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: 'wrong-password' }).triesLeft, 3);
});

test('sign in: 5 wrong passwords lock the name for 15 minutes, even for the right password', () => {
  const env = fresh();
  let last;
  for (let i = 0; i < 5; i++) last = env.call({ action: 'signIn', name: 'Abhijit Das', password: 'wrong-' + i + '-pw' });
  assert.strictEqual(last.triesLeft, 0);
  const locked = env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD });
  assert.strictEqual(locked.code, 'locked');
  assert.match(locked.error, /15 minutes/);
  env.advance(14 * 60000);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD }).code, 'locked');
  env.advance(2 * 60000);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD }).ok, true);
});

test('sign in: a good sign-in clears the failed tries', () => {
  const env = fresh();
  for (let i = 0; i < 4; i++) env.call({ action: 'signIn', name: 'Abhijit Das', password: 'wrong-' + i + '-pw' });
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD }).ok, true);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: 'wrong-again' }).triesLeft, 4);
});

test('sign out ends that session only', () => {
  const env = fresh();
  const other = env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD, device: 'iPhone' }).session;
  assert.strictEqual(env.call({ action: 'signOut', session: other }).ok, true);
  assert.strictEqual(pull(env, other).code, 'sessionEnded');
  assert.strictEqual(pull(env, env.ownerSession).ok, true);
});

test('a missing, made-up or damaged session code is refused', () => {
  const env = fresh();
  for (const s of [undefined, '', 'abc', env.ownerSession + 'x', 12345]) {
    const r = env.call({ action: 'pull', session: s });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'sessionEnded');
  }
});

test('a session unused for 90 days ends; using it within 90 days keeps it alive', () => {
  const env = fresh();
  env.advance(60 * DAY);
  assert.strictEqual(pull(env, env.ownerSession).ok, true);
  env.advance(60 * DAY);
  assert.strictEqual(pull(env, env.ownerSession).ok, true);
  env.advance(91 * DAY);
  const r = pull(env, env.ownerSession);
  assert.deepStrictEqual([r.code, r.reason], ['sessionEnded', 'expired']);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD }).ok, true);
});

test('change password: needs the old one, enforces length, then the new one works and the old does not', () => {
  const env = fresh();
  assert.strictEqual(env.call({ action: 'changePassword', session: env.ownerSession, oldPassword: 'nope-nope-1', newPassword: 'brand new pass' }).code, 'badLogin');
  assert.match(env.call({ action: 'changePassword', session: env.ownerSession, oldPassword: PASSWORD, newPassword: 'short' }).error, /8 characters/);
  assert.strictEqual(env.call({ action: 'changePassword', session: env.ownerSession, oldPassword: PASSWORD, newPassword: 'brand new pass' }).ok, true);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: PASSWORD }).code, 'badLogin');
  assert.strictEqual(env.call({ action: 'signIn', name: 'Abhijit Das', password: 'brand new pass' }).ok, true);
  assert.strictEqual(pull(env, env.ownerSession).ok, true);
});

// ------------------------------------------------------------------ Invites

test('invite: code looks like XXXX-XXXX-XXXX, works once, and the person picks their own password', () => {
  const env = fresh();
  const inv = env.call({ action: 'invite', session: env.ownerSession, name: 'Tashi Sherpa', role: 'Staff' });
  assert.match(inv.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.strictEqual(inv.expiresAt, '2026-11-12T09:00:00Z');
  assert.match(env.call({ action: 'join', invite: inv.code, password: 'short' }).error, /8 characters/);
  const j = env.call({ action: 'join', invite: inv.code.toLowerCase().replace(/-/g, ' '), password: 'tashi-password-1', device: 'Web' });
  assert.strictEqual(j.ok, true);
  assert.deepStrictEqual(j.person, { id: j.person.id, name: 'Tashi Sherpa', role: 'Staff' });
  assert.strictEqual(env.call({ action: 'join', invite: inv.code, password: 'another-pass-2' }).code, 'badInvite');
  assert.strictEqual(env.call({ action: 'signIn', name: 'Tashi Sherpa', password: 'tashi-password-1' }).ok, true);
});

test('invite: expires after 7 days, a new invite replaces the old, wrong codes are refused', () => {
  const env = fresh();
  const first = env.call({ action: 'invite', session: env.ownerSession, name: 'Tashi Sherpa', role: 'Staff' });
  env.advance(8 * DAY);
  assert.strictEqual(env.call({ action: 'join', invite: first.code, password: 'tashi-password-1' }).code, 'inviteExpired');
  const second = env.call({ action: 'invite', session: env.ownerSession, personId: first.person.id });
  assert.notStrictEqual(second.code, first.code);
  assert.strictEqual(env.call({ action: 'join', invite: first.code, password: 'tashi-password-1' }).code, 'badInvite');
  assert.strictEqual(env.call({ action: 'join', invite: 'AAAA-BBBB-CCCC', password: 'tashi-password-1' }).code, 'badInvite');
  assert.strictEqual(env.call({ action: 'join', invite: second.code, password: 'tashi-password-1' }).ok, true);
});

test('invite: a name already used is refused (any case), and so are bad roles and short names', () => {
  const env = fresh();
  assert.strictEqual(env.call({ action: 'invite', session: env.ownerSession, name: 'abhijit das', role: 'Staff' }).code, 'nameTaken');
  assert.strictEqual(env.call({ action: 'invite', session: env.ownerSession, name: 'Tashi', role: 'Boss' }).code, 'badRequest');
  assert.strictEqual(env.call({ action: 'invite', session: env.ownerSession, name: 'T', role: 'Staff' }).code, 'badRequest');
  assert.strictEqual(env.call({ action: 'invite', session: env.ownerSession, name: 'Tashi', role: 'Staff' }).ok, true);
});

test('invite codes can only be guessed 20 times in 15 minutes', () => {
  const env = fresh();
  const inv = env.call({ action: 'invite', session: env.ownerSession, name: 'Tashi Sherpa', role: 'Staff' });
  for (let i = 0; i < 20; i++) env.call({ action: 'join', invite: 'AAAA-BBBB-' + (1000 + i), password: 'tashi-password-1' });
  assert.strictEqual(env.call({ action: 'join', invite: inv.code, password: 'tashi-password-1' }).code, 'locked');
  env.advance(16 * 60000);
  assert.strictEqual(env.call({ action: 'join', invite: inv.code, password: 'tashi-password-1' }).ok, true);
});

test('only an Owner can invite, list people, change roles, remove or reset', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  const staff = addPerson(env, 'Rohit Sharma', 'Staff');
  for (const who of [mgr, staff]) {
    for (const req of [
      { action: 'invite', name: 'X Y', role: 'Staff' }, { action: 'people' },
      { action: 'setRole', personId: env.ownerId, role: 'Staff' }, { action: 'removePerson', personId: env.ownerId },
      { action: 'resetSignIn', personId: env.ownerId },
    ]) {
      const r = env.call({ ...req, session: who.session });
      assert.strictEqual(r.code, 'forbidden', req.action);
    }
  }
  assert.strictEqual(pull(env, env.ownerSession).person.role, 'Owner');
});

// ------------------------------------------------------------------ People management

test('people list shows status, role, who added them and what they recorded', () => {
  const env = fresh();
  const staff = addPerson(env, 'Rohit Sharma', 'Staff');
  env.call({ action: 'invite', session: env.ownerSession, name: 'Karan Bose', role: 'Staff' });
  push(env, staff.session, [
    table('Money', moneyH, [moneyRow({ id: 'M1', kind: 'Money in', amount: 5, updatedAt: at(1), createdBy: staff.id })]),
    table('Bookings', bookingsH, [bookingRow({ id: 'B1', travellers: ['A'], updatedAt: at(1), createdBy: staff.id })]),
  ]);
  const r = env.call({ action: 'people', session: env.ownerSession });
  const rohit = r.people.find((p) => p.name === 'Rohit Sharma');
  assert.deepStrictEqual([rohit.role, rohit.status, rohit.addedBy, rohit.payments, rohit.bookings], ['Staff', 'active', 'Abhijit Das', 1, 1]);
  assert.strictEqual(r.people.find((p) => p.name === 'Karan Bose').status, 'invited');
  assert.ok(r.people.find((p) => p.name === 'Karan Bose').inviteExpiresAt);
  assert.deepStrictEqual(rohit.devices, ['Web']);
  assert.ok(rohit.lastSyncAt);
  assert.strictEqual(JSON.stringify(r).includes('hash'), false);
});

test('a role change applies at the person\'s next call', () => {
  const env = fresh();
  const p = addPerson(env, 'Meera Paul', 'Staff');
  assert.strictEqual(pull(env, p.session).person.role, 'Staff');
  assert.strictEqual(env.call({ action: 'setRole', session: env.ownerSession, personId: p.id, role: 'Manager' }).ok, true);
  assert.strictEqual(pull(env, p.session).person.role, 'Manager');
});

test('there is always an Owner: the last one cannot be demoted or removed, two Owners can', () => {
  const env = fresh();
  assert.strictEqual(env.call({ action: 'setRole', session: env.ownerSession, personId: env.ownerId, role: 'Manager' }).code, 'lastOwner');
  assert.strictEqual(env.call({ action: 'removePerson', session: env.ownerSession, personId: env.ownerId }).code, 'lastOwner');
  const second = addPerson(env, 'Meera Paul', 'Owner');
  assert.strictEqual(env.call({ action: 'setRole', session: second.session, personId: env.ownerId, role: 'Manager' }).ok, true);
  assert.strictEqual(env.call({ action: 'removePerson', session: second.session, personId: second.id }).code, 'lastOwner');
  assert.strictEqual(env.call({ action: 'setRole', session: second.session, personId: second.id, role: 'Staff' }).code, 'lastOwner');
});

test('removing a person ends every session, with the reason; their records stay', () => {
  const env = fresh();
  const p = addPerson(env, 'Rohit Sharma', 'Staff');
  const second = env.call({ action: 'signIn', name: 'Rohit Sharma', password: p.password, device: 'iPhone' }).session;
  push(env, p.session, [table('Bookings', bookingsH, [bookingRow({ id: 'B1', travellers: ['A'], updatedAt: at(1), createdBy: p.id })])]);
  assert.strictEqual(env.call({ action: 'removePerson', session: env.ownerSession, personId: p.id }).ok, true);
  for (const s of [p.session, second]) {
    const r = pull(env, s);
    assert.deepStrictEqual([r.code, r.reason], ['sessionEnded', 'removed']);
    assert.match(r.error, /removed your access/);
  }
  assert.strictEqual(env.call({ action: 'signIn', name: 'Rohit Sharma', password: p.password }).code, 'badLogin');
  const mine = pull(env, env.ownerSession);
  assert.strictEqual(byId(lines(mine, 'Bookings'), 'B1').createdBy, p.id);
  assert.ok(mine.directory.some((d) => d.name === 'Rohit Sharma'));
  assert.strictEqual(env.call({ action: 'people', session: env.ownerSession }).people.find((x) => x.id === p.id).status, 'disabled');
});

test('reset sign-in: password cleared, every device signed out, new invite; it also restores a removed person', () => {
  const env = fresh();
  const p = addPerson(env, 'Rohit Sharma', 'Staff');
  const r = env.call({ action: 'resetSignIn', session: env.ownerSession, personId: p.id });
  assert.strictEqual(r.ok, true);
  const gone = pull(env, p.session);
  assert.deepStrictEqual([gone.code, gone.reason], ['sessionEnded', 'reset']);
  assert.strictEqual(env.call({ action: 'signIn', name: 'Rohit Sharma', password: p.password }).code, 'badLogin');
  assert.strictEqual(env.call({ action: 'join', invite: r.code, password: 'a-new-password-9' }).ok, true);
  env.call({ action: 'removePerson', session: env.ownerSession, personId: p.id });
  const back = env.call({ action: 'resetSignIn', session: env.ownerSession, personId: p.id });
  assert.strictEqual(env.call({ action: 'join', invite: back.code, password: 'yet-another-pw-3' }).ok, true);
});

test('recoverOwner (run from the script editor) makes an Owner invite that works, even for a locked-out Owner', () => {
  const env = fresh();
  env.props.RECOVERY_NAME = 'Abhijit Das';
  const code = env.ctx.recoverOwner();
  assert.match(code, /^[A-Z0-9]{4}-/);
  assert.ok(env.logs.some((l) => l.includes(code)));
  assert.strictEqual(pull(env, env.ownerSession).code, 'sessionEnded');
  const j = env.call({ action: 'join', invite: code, password: 'recovered-password-1' });
  assert.deepStrictEqual([j.ok, j.person.role, j.person.id], [true, 'Owner', env.ownerId]);
  const stranger = makeEnv(SETUP);
  const c2 = stranger.ctx.recoverOwner();
  assert.strictEqual(stranger.call({ action: 'join', invite: c2, password: 'recovered-password-1' }).person.name, 'Recovered Owner');
});

// ------------------------------------------------------------------ Reading by role

function seeded() {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  const staff = addPerson(env, 'Rohit Sharma', 'Staff');
  const r = push(env, env.ownerSession, [
    table('Treks', treksH, [trekRow(trek('T1', 'Kuari Pass', 1))]),
    table('Bookings', bookingsH, [bookingRow({ id: 'B1', travellers: ['Pooja'], updatedAt: at(1), createdBy: env.ownerId })]),
    table('Money', moneyH, [
      moneyRow({ id: 'M1', kind: 'Money in', amount: 12500, updatedAt: at(1), createdBy: env.ownerId }),
      moneyRow({ id: 'M2', kind: 'Money out', amount: 8000, updatedAt: at(1), createdBy: env.ownerId }),
    ]),
    table('Vendors', vendorsH, [vendorRow({ id: 'V1', name: 'Porters', rate: 900, rateUnit: 'per day', phone: '98300', agreements: [{ trekID: 'T1', trekName: 'Kuari Pass', amount: 40000 }], updatedAt: at(1), createdBy: env.ownerId })]),
    table('Guidance', guidanceH, [ruleRow({ id: 'G1', text: 'Always quote GST', updatedAt: at(1), createdBy: env.ownerId })]),
  ]);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.rejected, []);
  return { env, mgr, staff };
}

test('Owner and Manager read everything', () => {
  const { env, mgr } = seeded();
  for (const s of [env.ownerSession, mgr.session]) {
    const r = pull(env, s);
    assert.strictEqual(r.tables.Money.length, 2);
    const v = byId(lines(r, 'Vendors'), 'V1');
    assert.strictEqual(v.rate, 900);
    assert.strictEqual(v.agreements.length, 1);
  }
});

test('Staff never receive money out, vendor rates or agreements; they do receive names, phones, payments received', () => {
  const { env, staff } = seeded();
  const r = pull(env, staff.session);
  assert.deepStrictEqual(lines(r, 'Money').map((m) => m.id), ['M1']);
  assert.ok(!JSON.stringify(r).includes('8000'));
  const v = byId(lines(r, 'Vendors'), 'V1');
  assert.deepStrictEqual([v.name, v.phone, v.rate, v.agreements], ['Porters', '98300', undefined, []]);
  assert.ok(!JSON.stringify(r).includes('40000'));
  assert.ok(!JSON.stringify(r).includes('900'));
  assert.strictEqual(lines(r, 'Bookings').length, 1);
  assert.strictEqual(lines(r, 'Treks').length, 1);
  assert.strictEqual(lines(r, 'Guidance').length, 1);
  assert.strictEqual(r.person.role, 'Staff');
});

test('the sheet itself keeps the full vendor record when a Staff phone pulls', () => {
  const { env, staff } = seeded();
  pull(env, staff.session);
  assert.strictEqual(byId(lines(pull(env, env.ownerSession), 'Vendors'), 'V1').rate, 900);
});

// ------------------------------------------------------------------ Writing: per-record merge

test('two people push different records at the same time: both are kept, no conflict', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari Pass', 1, { createdBy: env.ownerId }))])]);
  const r = push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('B', 'Sandakphu', 1, { createdBy: mgr.id }))])]);
  assert.strictEqual(r.ok, true);
  const got = lines(pull(env, env.ownerSession), 'Treks').map((t) => t.id).sort();
  assert.deepStrictEqual(got, ['A', 'B']);
});

test('the same record: the newer change wins, an older one is ignored, with no version number needed', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Old name', 5, { createdBy: env.ownerId }))])]);
  push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Newer name', 9))])]);
  const stale = push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Stale name', 7))])]);
  assert.strictEqual(stale.accepted.Treks, 0);
  assert.strictEqual(byId(lines(pull(env, env.ownerSession), 'Treks'), 'A').name, 'Newer name');
});

test('a pushed subset never removes other records (a Staff phone that lacks some records cannot wipe them)', () => {
  const { env, staff } = seeded();
  push(env, staff.session, [table('Money', moneyH, [moneyRow({ id: 'M3', kind: 'Money in', amount: 700, updatedAt: at(2), createdBy: staff.id })])]);
  const ids = lines(pull(env, env.ownerSession), 'Money').map((m) => m.id).sort();
  assert.deepStrictEqual(ids, ['M1', 'M2', 'M3']);
});

test('a deletion (tombstone) as new as the edit wins; a later edit brings the record back', () => {
  const env = fresh();
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 5, { createdBy: env.ownerId }))])]);
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 8, { deletedAt: at(8) }))])]);
  const same = push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Edited at same moment', 8))])]);
  assert.strictEqual(same.accepted.Treks, 0);
  assert.ok(byId(lines(pull(env, env.ownerSession), 'Treks'), 'A').deletedAt);
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Back again', 9))])]);
  const t = byId(lines(pull(env, env.ownerSession), 'Treks'), 'A');
  assert.strictEqual(t.name, 'Back again');
  assert.strictEqual(t.deletedAt, undefined);
});

test('an unchanged record or one with the same stamp and content is not counted and does not move the version', () => {
  const env = fresh();
  const row = trekRow(trek('A', 'Kuari', 5, { createdBy: env.ownerId }));
  const first = push(env, env.ownerSession, [table('Treks', treksH, [row])]);
  const again = push(env, env.ownerSession, [table('Treks', treksH, [row])]);
  assert.strictEqual(first.accepted.Treks, 1);
  assert.strictEqual(again.accepted.Treks, 0);
  assert.strictEqual(again.version, first.version);
});

test('derived changes at the same stamp (seats left) are taken but keep the author', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 5, { seatsLeft: 10, createdBy: env.ownerId }))])]);
  push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 5, { seatsLeft: 7 }))])]);
  const t = byId(lines(pull(env, env.ownerSession), 'Treks'), 'A');
  assert.deepStrictEqual([t.seatsLeft, t.createdBy, t.updatedBy], [7, env.ownerId, env.ownerId]);
});

test('hand-typed rows and extra tabs in the sheet are left alone', () => {
  const env = fresh();
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 5))])]);
  env.sheets.Treks.grid.push(['', 'My own note', '', '', 'remember to call']);
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('B', 'Sandakphu', 6))])]);
  assert.ok(env.sheets.Treks.grid.some((r) => r[1] === 'My own note'));
  assert.strictEqual(lines(pull(env, env.ownerSession), 'Treks').length, 2);
});

test('the sheet gets Added by and Last changed by columns with names, and the log names the person', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 5, { createdBy: env.ownerId }))])]);
  push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Kuari 2', 9))])]);
  const grid = env.sheets.Treks.grid;
  assert.deepStrictEqual(grid[0], [...treksH, 'Added by', 'Last changed by']);
  assert.deepStrictEqual(grid[1].slice(-2), ['Abhijit Das', 'Meera Paul']);
  const log = env.sheets['Sync log'].grid;
  assert.deepStrictEqual(log.slice(1).map((r) => r[1]), ['Abhijit Das', 'Meera Paul']);
});

test('numbers stay numbers and text columns stay text after a merge', () => {
  const env = fresh();
  push(env, env.ownerSession, [table('Money', moneyH, [moneyRow({ id: 'M1', kind: 'Money in', amount: 5000, updatedAt: at(1) })])]);
  push(env, env.ownerSession, [table('Money', moneyH, [moneyRow({ id: 'M2', kind: 'Money in', amount: 700, updatedAt: at(1) })])]);
  assert.strictEqual(env.sheets.Money.formats[3], '#,##0');
  assert.strictEqual(env.sheets.Money.formats[2], '@');
  assert.strictEqual(env.sheets.Money.grid[1][2], 5000);
});

// ------------------------------------------------------------------ Writing: authorship

test('a new record must name the person pushing it as its author; the script stamps who changed it last', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  const lie = push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 1, { createdBy: env.ownerId }))])]);
  assert.strictEqual(lie.accepted.Treks, 0);
  assert.match(lie.rejected[0].reason, /someone else/);
  const ok = push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 1, { createdBy: mgr.id, updatedBy: env.ownerId }))])]);
  assert.strictEqual(ok.accepted.Treks, 1);
  const t = byId(lines(pull(env, env.ownerSession), 'Treks'), 'A');
  assert.deepStrictEqual([t.createdBy, t.updatedBy], [mgr.id, mgr.id]);
});

test('editing keeps the original author and sets the editor; a forged createdBy on an edit is ignored', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 1, { createdBy: env.ownerId }))])]);
  push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Kuari v2', 2, { createdBy: mgr.id, updatedBy: env.ownerId }))])]);
  const t = byId(lines(pull(env, env.ownerSession), 'Treks'), 'A');
  assert.deepStrictEqual([t.name, t.createdBy, t.updatedBy], ['Kuari v2', env.ownerId, mgr.id]);
});

test('records from before sign-in stay without a name, even when someone edits them later', () => {
  const env = fresh();
  const mgr = addPerson(env, 'Meera Paul', 'Manager');
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Old trek', 1))])]);
  let t = byId(lines(pull(env, env.ownerSession), 'Treks'), 'A');
  assert.deepStrictEqual([t.createdBy, t.updatedBy], [undefined, undefined]);
  push(env, mgr.session, [table('Treks', treksH, [trekRow(trek('A', 'Old trek edited', 2))])]);
  t = byId(lines(pull(env, env.ownerSession), 'Treks'), 'A');
  assert.deepStrictEqual([t.createdBy, t.updatedBy], [undefined, mgr.id]);
});

// ------------------------------------------------------------------ Writing: roles

test('Staff cannot change treks, vendors or rules', () => {
  const { env, staff } = seeded();
  const r = push(env, staff.session, [
    table('Treks', treksH, [trekRow(trek('T1', 'Hacked', 50))]),
    table('Vendors', vendorsH, [vendorRow({ id: 'V1', name: 'Hacked', updatedAt: at(50) })]),
    table('Guidance', guidanceH, [ruleRow({ id: 'G1', text: 'Hacked', updatedAt: at(50) })]),
  ]);
  assert.deepStrictEqual(r.accepted, { Treks: 0, Vendors: 0, Guidance: 0 });
  assert.strictEqual(r.rejected.length, 3);
  const all = pull(env, env.ownerSession);
  assert.strictEqual(byId(lines(all, 'Treks'), 'T1').name, 'Kuari Pass');
  assert.strictEqual(byId(lines(all, 'Vendors'), 'V1').rate, 900);
});

test('Staff can create bookings and change their own, but not cancel or delete, and not other people\'s', () => {
  const { env, staff, mgr } = seeded();
  const own = { id: 'B2', travellers: ['Ankit', 'Sneha'], updatedAt: at(3), createdBy: staff.id };
  assert.strictEqual(push(env, staff.session, [table('Bookings', bookingsH, [bookingRow(own)])]).accepted.Bookings, 1);
  assert.strictEqual(push(env, staff.session, [table('Bookings', bookingsH, [bookingRow({ ...own, payment: 'Paid', updatedAt: at(4) })])]).accepted.Bookings, 1);
  const cancel = push(env, staff.session, [table('Bookings', bookingsH, [bookingRow({ ...own, cancelledAt: at(5), updatedAt: at(5) })])]);
  assert.strictEqual(cancel.accepted.Bookings, 0);
  assert.match(cancel.rejected[0].reason, /cancel/);
  const del = push(env, staff.session, [table('Bookings', bookingsH, [bookingRow({ ...own, deletedAt: at(6), updatedAt: at(6) })])]);
  assert.match(del.rejected[0].reason, /delete/);
  const others = push(env, staff.session, [table('Bookings', bookingsH, [bookingRow({ id: 'B1', travellers: ['Pooja'], payment: 'Paid', updatedAt: at(7) })])]);
  assert.match(others.rejected[0].reason, /you added/);
  assert.strictEqual(byId(lines(pull(env, env.ownerSession), 'Bookings'), 'B2').payment, 'Paid');
  assert.strictEqual(push(env, mgr.session, [table('Bookings', bookingsH, [bookingRow({ ...own, cancelledAt: at(8), updatedAt: at(8) })])]).accepted.Bookings, 1);
});

test('Staff can record and change their own payments received, but not money out, deletions or other people\'s entries', () => {
  const { env, staff } = seeded();
  const mine = { id: 'M9', kind: 'Money in', amount: 3000, updatedAt: at(3), createdBy: staff.id };
  assert.strictEqual(push(env, staff.session, [table('Money', moneyH, [moneyRow(mine)])]).accepted.Money, 1);
  assert.strictEqual(push(env, staff.session, [table('Money', moneyH, [moneyRow({ ...mine, amount: 3500, updatedAt: at(4) })])]).accepted.Money, 1);
  const out = push(env, staff.session, [table('Money', moneyH, [moneyRow({ id: 'M10', kind: 'Money out', amount: 1, updatedAt: at(5), createdBy: staff.id })])]);
  assert.match(out.rejected[0].reason, /payments received/);
  const flip = push(env, staff.session, [table('Money', moneyH, [moneyRow({ ...mine, kind: 'Money out', updatedAt: at(6) })])]);
  assert.match(flip.rejected[0].reason, /payments received/);
  const del = push(env, staff.session, [table('Money', moneyH, [moneyRow({ ...mine, deletedAt: at(7), updatedAt: at(7) })])]);
  assert.match(del.rejected[0].reason, /delete/);
  const theirs = push(env, staff.session, [table('Money', moneyH, [moneyRow({ id: 'M1', kind: 'Money in', amount: 1, updatedAt: at(9) })])]);
  assert.match(theirs.rejected[0].reason, /you recorded/);
  const m = lines(pull(env, env.ownerSession), 'Money');
  assert.strictEqual(byId(m, 'M9').amount, 3500);
  assert.strictEqual(byId(m, 'M1').amount, 12500);
  assert.strictEqual(m.length, 3);
});

test('Manager can change all business data; only a Manager or Owner can delete', () => {
  const { env, mgr } = seeded();
  const r = push(env, mgr.session, [
    table('Treks', treksH, [trekRow(trek('T1', 'Kuari Pass v2', 10))]),
    table('Vendors', vendorsH, [vendorRow({ id: 'V1', name: 'Porters', rate: 950, updatedAt: at(10) })]),
    table('Money', moneyH, [moneyRow({ id: 'M2', kind: 'Money out', amount: 8000, updatedAt: at(10), deletedAt: at(10) })]),
  ]);
  assert.deepStrictEqual(r.accepted, { Treks: 1, Vendors: 1, Money: 1 });
  assert.deepStrictEqual(r.rejected, []);
});

// ------------------------------------------------------------------ Bad requests

test('bad pushes change nothing', () => {
  const env = fresh();
  const before = env.version();
  const bads = [
    [table('Secrets', treksH, [])],
    [table('Treks', treksH, []), table('Treks', treksH, [])],
    [table('Treks', ['A', 'B'], [])],
    [table('Treks', treksH, [['only one']])],
    [table('Treks', treksH, [['A', 'B', 'C', 'D', { x: 1 }]])],
    [table('Treks', treksH, [['A', 'B', 'C', 'D', 'x'.repeat(49001)]])],
  ];
  for (const tables of bads) {
    const r = push(env, env.ownerSession, tables);
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(env.call({ action: 'push', session: env.ownerSession, tables: 'x' }).ok, false);
  assert.deepStrictEqual(Object.keys(env.sheets), []);
  assert.strictEqual(env.version(), before);
});

test('a push whose columns differ from the sheet\'s is refused with "Update the app"', () => {
  const env = fresh();
  push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 1))])]);
  const r = push(env, env.ownerSession, [table('Treks', ['Trek ID', 'Title', 'Updated at', 'Deleted at', 'Record (JSON)'], [['B', 'x', '', '', json(trek('B', 'x', 2))]])]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Update the app/);
});

test('an unreadable record is refused on its own; the others in the push still go in', () => {
  const env = fresh();
  const r = push(env, env.ownerSession, [table('Treks', treksH, [
    ['X', 'Broken', '', '', 'not json'], trekRow(trek('A', 'Kuari', 1)),
  ])]);
  assert.strictEqual(r.accepted.Treks, 1);
  assert.strictEqual(r.rejected[0].reason, 'Unreadable record.');
});

test('the version moves only when something was written', () => {
  const env = fresh();
  const a = push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 1))])]);
  const b = push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari', 1))])]);
  const c = push(env, env.ownerSession, [table('Treks', treksH, [trekRow(trek('A', 'Kuari 2', 2))])]);
  assert.deepStrictEqual([a.version, b.version, c.version], [1, 1, 2]);
  assert.strictEqual(pull(env, env.ownerSession).version, 2);
});

test('an old app (token, no session) after the first Owner gets a clear message and changes nothing', () => {
  const env = fresh();
  const r = env.call({ token: SETUP, action: 'push', baseVersion: 0, tables: [table('Treks', treksH, [trekRow(trek('A', 'x', 1))])] });
  assert.deepStrictEqual([r.ok, r.code], [false, 'updateApp']);
  assert.deepStrictEqual(Object.keys(env.sheets), []);
});

console.log(`\n${passed} passed`);
