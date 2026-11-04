import { ADDRESS, at, codeOf, failure, sec } from './helpers';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  SheetSyncClient, SheetSyncError, buildTables, cleanName, describeTables, fetchTransport, rowCount, validateAddress,
  type SheetCell, type SheetTable, type TransportReply,
} from '../src/core/sheetsync';
import { decodeTables, mergeData, emptyData, recordCount } from '../src/core/syncmerge';
import { decodeLine, encodeRecord, parseTrek, parseBooking, parseEntry } from '../src/core/codec';
import { makeBooking, makeEntry, makeRule, makeTrek, makeVendor } from '../src/core/models';
import { MemoryKV } from '../src/core/storage';
import { SettingsStore } from '../src/core/settings';
import { encodeBackup } from '../src/core/backup';
import { MAX_NAME_LENGTH } from '../src/core/sheetsync';

/** Same fixture and expected cells as the iPhone and Android apps' sheet tests, so all three write identical sheets. */

const kuari = '11111111-1111-1111-1111-111111111111';
const sandak = '11111111-1111-1111-1111-222222222222';
const booking = '22222222-2222-2222-2222-222222222222';
const vendor = '33333333-3333-3333-3333-333333333333';
const rule = '44444444-4444-4444-4444-444444444444';
const credit = '55555555-5555-5555-5555-555555555555';
const debit = '66666666-6666-6666-6666-666666666666';

function fixture(): SheetTable[] {
  const treks = [
    makeTrek({ id: sandak, name: 'Sandakphu', durationDays: 5 }),
    makeTrek({
      id: kuari, name: 'Kuari Pass', region: 'Uttarakhand', durationDays: 6, difficulty: 'Hard', maxAltitudeFt: 12516,
      pricePerPerson: 14500, startDate: at(2026, 12, 5), seatsLeft: 4, highlights: 'Snow', notes: 'Pickup Haridwar',
    }),
  ];
  const bookings = [makeBooking({
    id: booking, trekID: kuari, travellers: ['Asha Rao', 'Dev Rao'], phone: '+91 98765 43210', payment: 'Part paid',
    amountReceived: 5000, createdAt: at(2026, 11, 3, 10, 30),
  })];
  const ledger = [
    makeEntry({
      id: debit, date: at(2026, 11, 5), kind: 'Money out', amount: 1500, mode: 'Cash', note: '=cmd',
      shares: [{ trekID: kuari, trekName: 'Kuari Pass', amount: 1500 }], vendorID: vendor, vendorName: 'Dorje', createdAt: at(2026, 11, 5, 9, 0),
    }),
    makeEntry({
      id: credit, date: at(2026, 11, 3), kind: 'Money in', amount: 5000, mode: 'UPI', bookingID: booking, customerName: 'Asha Rao',
      shares: [{ trekID: kuari, trekName: 'Kuari Pass', amount: 5000 }], createdAt: at(2026, 11, 3, 10, 31),
    }),
  ];
  const vendors = [makeVendor({
    id: vendor, name: 'Dorje', service: 'Guide', contactName: 'Dorje S', phone: '98765', rate: 1500, rateUnit: 'per day',
    tags: ['darjeeling', 'winter'], notes: 'Reliable', agreements: [{ trekID: kuari, trekName: 'Kuari Pass', amount: 6000 }],
    createdAt: at(2026, 10, 1, 8, 0),
  })];
  const guidance = [makeRule('Always mention the pickup point', at(2026, 10, 2, 18, 5))];
  guidance[0].id = rule;
  return buildTables({ treks, bookings, ledger, vendors, guidance });
}

const table = (name: string) => fixture().find((t) => t.name === name)!;
/** A row as strings, without the three trailing sync columns. Numbers read as "#n". */
const text = (row: SheetCell[]) => row.slice(0, -3).map((c) => (typeof c === 'number' ? `#${c}` : c));

// ---- Tables

describe('tables', () => {
  it('has a row for every header', () => {
    const tables = fixture();
    expect(tables.map((t) => t.name)).toEqual(['Treks', 'Bookings', 'Money', 'Vendors', 'Guidance']);
    for (const t of tables) {
      expect(t.rows.length, t.name).toBeGreaterThan(0);
      for (const r of t.rows) expect(r.length, t.name).toBe(t.headers.length);
    }
  });

  it('lists treks soonest first, undated last', () => {
    const rows = table('Treks').rows.map(text);
    expect(rows[0]).toEqual([kuari, 'Kuari Pass', 'Uttarakhand', '#6', 'Hard', '#12516', '#14500', '2026-12-05', '#4', 'Snow', 'Pickup Haridwar']);
    expect(rows[1]).toEqual([sandak, 'Sandakphu', '', '#5', 'Moderate', '', '', '', '', '', '']);
  });

  it('writes the booking row', () => {
    expect(table('Bookings').rows.map(text)).toEqual([[
      booking, kuari, 'Kuari Pass', 'Asha Rao', 'Asha Rao, Dev Rao', '#2', '+91 98765 43210', 'Part paid', '#5000', '2026-11-03 10:30', '',
    ]]);
  });

  it('lists money oldest first with signed amounts', () => {
    const rows = table('Money').rows.map(text);
    expect(rows[0]).toEqual([credit, '2026-11-03', 'Money in', '#5000', '#5000', kuari, 'Kuari Pass', 'Asha Rao', booking, '', '', 'UPI', '', '2026-11-03 10:31']);
    expect(rows[1]).toEqual([debit, '2026-11-05', 'Money out', '#1500', '#-1500', kuari, 'Kuari Pass', '', '', 'Dorje', vendor, 'Cash', '=cmd', '2026-11-05 09:00']);
  });

  it('writes vendor and guidance rows', () => {
    expect(table('Vendors').rows.map(text)).toEqual([[
      vendor, 'Dorje', 'Guide', 'Dorje S', '98765', '#1500', 'per day', 'darjeeling, winter', 'Reliable', '#6000', 'Kuari Pass: 6000', '2026-10-01 08:00',
    ]]);
    expect(table('Guidance').rows.map(text)).toEqual([[rule, 'Always mention the pickup point', '2026-10-02 18:05']]);
  });

  it('reads a booking for a deleted trek', () => {
    const t = buildTables({ ...emptyData(), bookings: [makeBooking({ trekID: '99999999-9999-9999-9999-999999999999', travellers: ['Meera'], phone: '1' })] });
    expect(text(t[1].rows[0])[2]).toBe('(deleted trek)');
  });

  it('describes and counts', () => {
    expect(describeTables(fixture())).toBe('2 treks, 1 bookings, 2 transactions, 1 vendors, 1 rules');
    expect(rowCount(fixture())).toBe(7);
  });

  it('cleans a name', () => {
    expect(cleanName('  Meera \n Rao  ')).toBe('Meera   Rao');
    expect(cleanName('   ')).toBe('');
    expect(cleanName('a'.repeat(90)).length).toBe(MAX_NAME_LENGTH);
    expect(MAX_NAME_LENGTH).toBe(40);
  });

  it('ends every row with stamps and its record', () => {
    for (const t of fixture()) {
      expect(t.headers.slice(-3), t.name).toEqual(['Updated at', 'Deleted at', 'Record (JSON)']);
      for (const r of t.rows) {
        const json = r[r.length - 1] as string;
        expect(json.startsWith('{') && json.endsWith('}'), t.name).toBe(true);
      }
    }
    // The JSON column alone is enough to rebuild a record exactly.
    const back = decodeLine(parseTrek, table('Treks').rows[0].at(-1) as string)!;
    expect(back.id).toBe(kuari);
    expect(back.name).toBe('Kuari Pass');
    expect(back.seatsLeft).toBe(4);
  });

  it('shows the deletion of deleted rows and does not count them', () => {
    const gone = makeTrek({ name: 'Gone', deletedAt: at(2026, 11, 4, 9, 0), updatedAt: at(2026, 11, 4, 9, 0) });
    const tables = buildTables({ ...emptyData(), treks: [makeTrek({ name: 'Here' }), gone] });
    const col = tables[0].headers.indexOf('Deleted at');
    expect(new Set(tables[0].rows.map((r) => r[col]))).toEqual(new Set(['', '2026-11-04 09:00']));
    expect(describeTables(tables)).toBe('1 treks, 0 bookings, 0 transactions, 0 vendors, 0 rules');
  });
});

// ---- Address

describe('address', () => {
  it('accepts only Google script addresses', () => {
    expect(validateAddress(ADDRESS)).not.toBeNull();
    expect(validateAddress(`  ${ADDRESS} \n`)).not.toBeNull();
    expect(validateAddress('https://script.google.com/a/macros/pahadisoul.in/s/AKfy/exec')).not.toBeNull();
    for (const bad of [
      'http://script.google.com/macros/s/x/exec',
      'https://example.com/macros/s/x/exec',
      'https://script.google.com.evil.com/macros/s/x/exec',
      'https://script.google.com@evil.com/macros/s/x/exec',
      'https://user:pw@script.google.com/macros/s/x/exec',
      'https://script.google.com/macros/s/x/dev',
      'https://script.google.com/macros/s/x/exec?a=1',
      'https://script.google.com:8443/macros/s/x/exec',
      'https://script.google.com/other/exec',
      '', 'not a url',
    ]) expect(validateAddress(bad), bad).toBeNull();
  });
});

// ---- Sending

class Recorder {
  calls: { url: string; body: string }[] = [];
  reply: () => Promise<TransportReply> = async () => ({ status: 200, body: '{"ok":true}' });
  transport = async (url: string, body: string) => { this.calls.push({ url, body }); return this.reply(); };
}

function clientFor(json: string, status = 200, rec = new Recorder()) {
  rec.reply = async () => ({ status, body: json });
  return new SheetSyncClient(rec.transport);
}

const sentBody = (rec: Recorder, i = 0) => JSON.parse(rec.calls[i].body);

describe('client', () => {
  it('pushes one POST with the secret, name and every table', async () => {
    const rec = new Recorder();
    const c = clientFor('{"ok":true,"written":{"Treks":2,"Money":2},"keptAsIs":["Vendors"]}', 200, rec);
    const result = await c.push(fixture(), ADDRESS, 's3cret', ' Meera ', 'Android', 7, sec(0));
    expect(result).toEqual({ written: { Treks: 2, Money: 2 }, keptAsIs: ['Vendors'], version: 8 });

    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0].url).toBe(ADDRESS);
    const body = sentBody(rec);
    expect(body.token).toBe('s3cret');
    expect(body.action).toBe('push');
    expect(body.baseVersion).toBe(7);
    expect(body.user).toBe('Meera');
    expect(body.device).toBe('Android');
    expect(body.sentAt).toBe('1970-01-01T00:00:00Z');
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(['Treks', 'Bookings', 'Money', 'Vendors', 'Guidance']);
    // Amounts travel as numbers, everything else as text.
    const moneyRow = body.tables[2].rows[0];
    expect(typeof moneyRow[3]).toBe('number');
    expect(typeof moneyRow[2]).toBe('string');
  });

  it('needs a name', async () => {
    const rec = new Recorder();
    const e = await failure(clientFor('{"ok":true}', 200, rec).push(fixture(), ADDRESS, 's', '  ', 'Android', 0));
    expect(codeOf(e)).toBe('nameRequired');
    expect(rec.calls).toEqual([]);
  });

  it('sends nothing when there is no data', async () => {
    const rec = new Recorder();
    const e = await failure(clientFor('{"ok":true}', 200, rec).push(buildTables(emptyData()), ADDRESS, 's', 'Meera', 'Android', 0));
    expect(codeOf(e)).toBe('nothingToSync');
    expect(rec.calls).toEqual([]);
  });

  it('never calls a bad address', async () => {
    const rec = new Recorder();
    const e = await failure(clientFor('{"ok":true}', 200, rec).push(fixture(), 'https://evil.example/exec', 's', 'Meera', 'Android', 0));
    expect(codeOf(e)).toBe('badAddress');
    expect(rec.calls).toEqual([]);
  });

  it('refuses a body that is too large', async () => {
    const rec = new Recorder();
    const huge = buildTables({ ...emptyData(), guidance: [makeRule('x'.repeat(16_000_000))] });
    const e = await failure(clientFor('{"ok":true}', 200, rec).push(huge, ADDRESS, 's', 'Meera', 'Android', 0));
    expect(codeOf(e)).toBe('tooLarge');
    expect(rec.calls).toEqual([]);
  });

  it('passes a transport failure through unchanged', async () => {
    const rec = new Recorder();
    rec.reply = async () => { throw new SheetSyncError('offline'); };
    const e = await failure(new SheetSyncClient(rec.transport).push(fixture(), ADDRESS, 's', 'Meera', 'Android', 0));
    expect(codeOf(e)).toBe('offline');
    expect((e as Error).message).toContain('safe on this phone');
  });

  it('says an HTML page means the address is not the script', async () => {
    const e = await failure(clientFor('<html>Sign in to Google</html>').ping(ADDRESS, 's'));
    expect(codeOf(e)).toBe('notTheScript');
  });

  it("shows the script's refusal as is", async () => {
    const e = await failure(clientFor('{"ok":false,"error":"Wrong secret code."}').push(fixture(), ADDRESS, 'bad', 'Meera', 'Android', 0));
    expect(codeOf(e)).toBe('rejected');
    expect((e as Error).message).toBe('Wrong secret code.');
  });

  it('pings and returns the sheet name', async () => {
    const rec = new Recorder();
    expect(await clientFor('{"ok":true,"spreadsheet":"Pahadi Soul Planner App"}', 200, rec).ping(ADDRESS, 's')).toBe('Pahadi Soul Planner App');
    expect(sentBody(rec).action).toBe('ping');
    expect(sentBody(rec).tables).toBeUndefined();
  });

  it('pulls the version and the record lines', async () => {
    const rec = new Recorder();
    const c = clientFor('{"ok":true,"version":5,"tables":{"Treks":["{\\"a\\":1}","{\\"b\\":2}"],"Money":[]}}', 200, rec);
    const pulled = await c.pull(ADDRESS, 's3cret');
    expect(pulled).toEqual({ version: 5, tables: { Treks: ['{"a":1}', '{"b":2}'], Money: [] } });
    expect(sentBody(rec).action).toBe('pull');
    expect(sentBody(rec).token).toBe('s3cret');
    expect(sentBody(rec).tables).toBeUndefined();
  });

  it('treats a pull reply without a version as not the script', async () => {
    const e = await failure(clientFor('{"ok":true,"tables":{}}').pull(ADDRESS, 's'));
    expect(codeOf(e)).toBe('notTheScript');
  });

  it("turns the sheet's conflict code into changedMeanwhile", async () => {
    const e = await failure(clientFor('{"ok":false,"code":"conflict","error":"changed"}').push(fixture(), ADDRESS, 's', 'Meera', 'Android', 3));
    expect(codeOf(e)).toBe('changedMeanwhile');
  });

  it('words the errors like the other apps', () => {
    expect(new SheetSyncError('changedMeanwhile').message).toBe('Someone else synced at the same moment.');
    expect(new SheetSyncError('busy').message).toBe('Others kept syncing at the same time. Nothing was lost. Try again in a minute.');
    expect(new SheetSyncError('unreadableRows', { count: 1 }).message).toBe(
      "The sheet has 1 row this app can't read, perhaps from a newer version of the app. Update the app, then sync again. Nothing was changed.");
    expect(new SheetSyncError('unreadableRows', { count: 2 }).message.startsWith('The sheet has 2 rows this app')).toBe(true);
    expect(new SheetSyncError('nothingToSync').message).toBe('There is no data in the app or the sheet yet, so there is nothing to sync.');
    expect(new SheetSyncError('network', { why: 'handshake failed' }).message).toBe("Couldn't reach Google: handshake failed");
  });
});

// ---- Lines written by the iPhone app

// Lines produced by the iPhone app's own encoder, for the same fixture ids.
const iphoneTrek = '{"difficulty":"Hard","durationDays":6,"highlights":"Snow","id":"11111111-1111-1111-1111-111111111111","maxAltitudeFt":12516,"name":"Kuari Pass","notes":"Pickup Haridwar","pricePerPerson":14500,"region":"Uttarakhand","seatCapacity":6,"seatsLeft":4,"startDate":"2026-12-04T18:30:00Z","updatedAt":"2026-11-03T04:30:00Z"}';
const iphoneBooking = '{"amountReceived":5000,"createdAt":"2026-11-03T05:00:00Z","id":"22222222-2222-2222-2222-222222222222","payment":"Part paid","phone":"+91 98765 43210","travellers":["Asha Rao","Dev Rao"],"trekID":"11111111-1111-1111-1111-111111111111","updatedAt":"2026-11-03T05:00:00Z"}';
const iphoneEntry = '{"amount":5000,"bookingID":"22222222-2222-2222-2222-222222222222","createdAt":"2026-11-03T05:01:00Z","customerName":"Asha Rao","date":"2026-11-02T18:30:00Z","deletedAt":"2026-11-04T03:30:00Z","id":"55555555-5555-5555-5555-555555555555","kind":"Money in","mode":"UPI","note":"","party":"","shares":[{"amount":5000,"trekID":"11111111-1111-1111-1111-111111111111","trekName":"Kuari Pass"}],"updatedAt":"2026-11-03T05:01:00Z"}';

describe('record lines from the iPhone app', () => {
  it('load', () => {
    const t = decodeLine(parseTrek, iphoneTrek)!;
    expect(t.id).toBe(kuari);
    expect(t.name).toBe('Kuari Pass');
    expect(t.difficulty).toBe('Hard');
    expect(t.seatCapacity).toBe(6);
    expect(t.seatsLeft).toBe(4);
    expect(t.startDate).toBe(at(2026, 12, 5));
    expect(t.updatedAt).toBe(at(2026, 11, 3, 10, 0));
    expect(t.deletedAt).toBeUndefined();

    const b = decodeLine(parseBooking, iphoneBooking)!;
    expect(b.id).toBe(booking);
    expect(b.travellers).toEqual(['Asha Rao', 'Dev Rao']);
    expect(b.payment).toBe('Part paid');
    expect(b.amountReceived).toBe(5000);

    const e = decodeLine(parseEntry, iphoneEntry)!;
    expect(e.id).toBe(credit);
    expect(e.kind).toBe('Money in');
    expect(e.mode).toBe('UPI');
    expect(e.bookingID).toBe(booking);
    expect(e.shares).toEqual([{ trekID: kuari, trekName: 'Kuari Pass', amount: 5000 }]);
    expect(e.deletedAt).toBe(at(2026, 11, 4, 9, 0));
  });

  it('merge like any other remote rows', () => {
    const remote = decodeTables({ Treks: [iphoneTrek], Bookings: [iphoneBooking], Money: [iphoneEntry] });
    const { data, report } = mergeData(emptyData(), remote);
    expect(report.received).toBe(3);
    expect(report.sent).toBe(0);
    expect(recordCount(data)).toBe(3);
    expect(data.treks[0].seatsLeft).toBe(4); // 6 seats, 2 booked: the booking's two travellers
  });

  it('are written back with the same keys the iPhone writes, on one line', () => {
    const line = encodeRecord(decodeLine(parseTrek, iphoneTrek)!);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(Object.keys(JSON.parse(iphoneTrek)).sort());
    expect(line).toBe(iphoneTrek); // sorted keys, no spaces: identical text
    expect(line).not.toContain('\n');
  });
});

// ---- The real transport

describe('fetch transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows the 302 Google answers with and reaches the reply', async () => {
    // Apps Script answers a POST with a 302 to the real reply. A tiny local server plays Google.
    // @ts-ignore node types are not installed; this only runs under vitest in Node
    const http = await import('node:http');
    let postedType: string | undefined, postedBody = '', replyMethod: string | undefined;
    const server = http.createServer((req: any, res: any) => {
      let received = '';
      req.on('data', (c: unknown) => { received += String(c); });
      req.on('end', () => {
        if (req.method === 'POST') {
          postedType = req.headers['content-type'];
          postedBody = received;
          res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/macros/echo?user_content_key=abc` });
          res.end();
        } else {
          replyMethod = req.method;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true,"spreadsheet":"Redirected Sheet"}');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = server.address().port;
      const reply = await fetchTransport(`http://127.0.0.1:${port}/macros/s/AKfy/exec`, '{"token":"s3cret","action":"ping"}');
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body).spreadsheet).toBe('Redirected Sheet');
      expect(postedType).toBe('text/plain;charset=utf-8'); // a "simple" request: no CORS preflight
      expect(JSON.parse(postedBody).token).toBe('s3cret');
      expect(replyMethod).toBe('GET');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('reports being offline when the browser says so', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('navigator', { onLine: false });
    expect(codeOf(await failure(fetchTransport(ADDRESS, '{}')))).toBe('offline');
  });

  it('reports a timeout as offline', async () => {
    vi.stubGlobal('fetch', async () => { throw new DOMException('aborted', 'AbortError'); });
    expect(codeOf(await failure(fetchTransport(ADDRESS, '{}')))).toBe('offline');
  });

  it('explains a blocked request (CORS, or an Apps Script error page) while online', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('navigator', { onLine: true });
    const e = (await failure(fetchTransport(ADDRESS, '{}'))) as SheetSyncError;
    expect(e.code).toBe('network');
    expect(e.message).toContain('Anyone');
  });
});

// ---- Settings

describe('sync settings', () => {
  it('persist but never enter a backup', () => {
    const kv = new MemoryKV();
    const s = new SettingsStore(kv);
    expect(s.userName).toBe('');
    expect(s.syncUrl).toBe('');
    expect(s.lastSyncAt).toBeUndefined();
    s.setUserName('Meera'); s.setSyncUrl(ADDRESS); s.setLastSyncAt(sec(1000));

    const again = new SettingsStore(kv);
    expect(again.userName).toBe('Meera');
    expect(again.syncUrl).toBe(ADDRESS);
    expect(again.lastSyncAt).toBe(sec(1000));

    const json = encodeBackup({
      format: 'PahadiSoulBackup', version: 1, createdAt: sec(0), treks: [], bookings: [], ledger: [], vendors: [], guidance: [],
      systemPrompt: again.systemPrompt, model: again.model,
    });
    expect(json).not.toContain('Meera');
    expect(json).not.toContain('script.google.com');
  });

  it('caps the name at forty characters', () => {
    const s = new SettingsStore(new MemoryKV());
    s.setUserName('x'.repeat(100));
    expect(s.userName.length).toBe(40);
  });
});
