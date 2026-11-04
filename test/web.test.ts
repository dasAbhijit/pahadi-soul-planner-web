import { ADDRESS, at, codeOf, date, failure, frozenClock } from './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, decodeLine, encodeRecord, parseBooking, parseEntry, parseRule, parseTrek, parseVendor, same } from '../src/core/codec';
import { addDays, dayKey, fromDayKey, isId, newId, nowSecond, parseInstant, stampKey, startOfDay, toInstant } from '../src/core/ids';
import { LocalKV, MemoryKV } from '../src/core/storage';
import { BookingStore, LedgerStore, TrekStore, VendorStore, GuidanceStore } from '../src/core/stores';
import { fmtDate, fmtDateTime, trekSummary } from '../src/core/fmt';
import { makeTrek, trekEndDate } from '../src/core/models';
import { SyncList } from '../src/core/syncrecord';
import { GeminiClient, GeminiError } from '../src/core/gemini';
import { Secrets } from '../src/core/settings';
import { decodeTables, mergeData, emptyData } from '../src/core/syncmerge';
import { AppContainer } from '../src/core/app';

let clock: ReturnType<typeof frozenClock>;
beforeEach(() => { clock = frozenClock(); });
afterEach(() => { clock.restore(); vi.unstubAllGlobals(); });

// ---- Rows written by the Android and iPhone apps

// A line as the Android app writes it: fields in declaration order, defaults included, nothing for empty optionals.
const androidTrek = '{"id":"73716B09-B359-42AC-8734-2C5699185728","name":"Gorkhey","region":"","durationDays":4,"difficulty":"Moderate","pricePerPerson":9500,"startDate":"2026-11-19T18:30:00Z","seatsLeft":4,"highlights":"","notes":"","seatCapacity":6,"updatedAt":"2026-11-03T16:30:00Z"}';

describe('reading rows from the other apps', () => {
  it('reads an Android trek line', () => {
    const t = decodeLine(parseTrek, androidTrek)!;
    expect(t.id).toBe('73716B09-B359-42AC-8734-2C5699185728');
    expect(t.pricePerPerson).toBe(9500);
    expect(t.maxAltitudeFt).toBeUndefined();
    expect(t.startDate).toBe('2026-11-19T18:30:00Z');
    expect(t.deletedAt).toBeUndefined();
  });

  it('writes back the same record whatever order the keys came in', () => {
    const t = decodeLine(parseTrek, androidTrek)!;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(androidTrek)).reverse()));
    expect(encodeRecord(decodeLine(parseTrek, reordered)!)).toBe(encodeRecord(t));
    expect(same(decodeLine(parseTrek, reordered), t)).toBe(true);
  });

  it('reads a whole pull with all five tabs', () => {
    const data = decodeTables({
      Treks: [androidTrek],
      Bookings: ['{"id":"0F534A5C-14C3-4637-BE15-82AD258EF85D","trekID":"73716B09-B359-42AC-8734-2C5699185728","travellers":["Asha"],"phone":"","payment":"Pending","createdAt":"2026-11-03T16:30:00Z"}'],
      Money: [], Vendors: [], Guidance: ['{"id":"E4DBAC8C-7B9A-4906-9F48-2A1B673F100A","text":"Be brief","createdAt":"2026-11-03T16:30:00Z"}'],
    });
    expect(data.treks.length + data.bookings.length + data.guidance.length).toBe(3);
  });

  it('keeps one copy when the sheet holds the same id twice', () => {
    const data = decodeTables({ Treks: [androidTrek, androidTrek] });
    expect(data.treks.length).toBe(1);
  });

  it('uppercases ids so the same record matches across apps', () => {
    const t = decodeLine(parseTrek, androidTrek.replace('73716B09-B359-42AC-8734-2C5699185728', '73716b09-b359-42ac-8734-2c5699185728'))!;
    expect(t.id).toBe('73716B09-B359-42AC-8734-2C5699185728');
  });
});

describe('parser strictness', () => {
  const base = JSON.parse(androidTrek);

  it('takes defaults for missing optional fields', () => {
    const t = parseTrek({ id: base.id })!;
    expect(t).toEqual({ id: base.id, name: '', region: '', durationDays: 3, difficulty: 'Moderate', highlights: '', notes: '' });
  });

  it('treats null like a missing field', () => {
    const t = parseTrek({ ...base, pricePerPerson: null, deletedAt: null })!;
    expect(t.pricePerPerson).toBeUndefined();
    expect(t.deletedAt).toBeUndefined();
    expect('pricePerPerson' in t).toBe(false);
  });

  it('rejects a field of the wrong kind', () => {
    for (const bad of [
      { durationDays: '4' }, { durationDays: 4.5 }, { name: 5 }, { difficulty: 'Extreme' }, { startDate: '2026-11-19' },
      { startDate: 'tomorrow' }, { seatsLeft: '4' }, { id: 'not-a-uuid' }, { id: undefined }, { updatedAt: 12345 },
    ]) expect(parseTrek({ ...base, ...bad }), JSON.stringify(bad)).toBeNull();
    expect(parseTrek(null)).toBeNull();
    expect(parseTrek([])).toBeNull();
    expect(parseTrek('x')).toBeNull();
  });

  it('ignores keys it does not know', () => {
    expect(parseTrek({ ...base, futureField: { a: 1 } })).not.toBeNull();
    expect('futureField' in parseTrek({ ...base, futureField: 1 })!).toBe(false);
  });

  it('cuts dates to whole seconds', () => {
    expect(parseTrek({ ...base, startDate: '2026-11-19T18:30:00.789Z' })!.startDate).toBe('2026-11-19T18:30:00Z');
    expect(parseTrek({ ...base, startDate: '2026-11-20T00:00:00+05:30' })!.startDate).toBe('2026-11-19T18:30:00Z');
  });

  it('requires travellers and phone on a booking, as the other apps do', () => {
    const b = { id: newId(), trekID: newId(), travellers: ['A'], phone: '1', createdAt: '2026-11-03T16:30:00Z' };
    expect(parseBooking(b)).not.toBeNull();
    expect(parseBooking({ ...b, phone: undefined })).toBeNull();
    expect(parseBooking({ ...b, travellers: undefined })).toBeNull();
    expect(parseBooking({ ...b, travellers: ['A', 3] })).toBeNull();
    expect(parseBooking({ ...b, payment: 'Maybe' })).toBeNull();
  });

  it('checks nested shares and agreements', () => {
    const e = { id: newId(), date: '2026-11-03T00:00:00Z', kind: 'Money in', amount: 10, shares: [{ trekID: newId(), trekName: 'T', amount: 10 }] };
    expect(parseEntry(e)).not.toBeNull();
    expect(parseEntry({ ...e, shares: [{ trekID: 'x', trekName: 'T', amount: 10 }] })).toBeNull();
    expect(parseEntry({ ...e, shares: 'none' })).toBeNull();
    expect(parseEntry({ ...e, kind: 'Transfer' })).toBeNull();
    expect(parseEntry({ ...e, amount: 10.5 })).toBeNull();
    const v = { id: newId(), name: 'Dorje', agreements: [{ trekID: newId(), trekName: 'T', amount: 5 }] };
    expect(parseVendor(v)).not.toBeNull();
    expect(parseVendor({ ...v, name: undefined })).toBeNull();
    expect(parseVendor({ ...v, agreements: [{ trekID: newId() }] })).toBeNull();
    expect(parseVendor({ ...v, tags: [1] })).toBeNull();
    expect(parseRule({ id: newId(), text: 'x' })).not.toBeNull();
    expect(parseRule({ id: newId() })).toBeNull();
  });
});

describe('canonical JSON', () => {
  it('ignores key order and undefined, keeps array order', () => {
    expect(canonical({ b: 1, a: { d: 1, c: undefined, e: 2 } })).toBe('{"a":{"d":1,"e":2},"b":1}');
    expect(same({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(same({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(same({ a: undefined }, {})).toBe(true);
  });

  it('cuts date fields, and only date fields, to whole seconds', () => {
    expect(same({ createdAt: '2026-11-03T05:01:00.789Z' }, { createdAt: '2026-11-03T05:01:00Z' })).toBe(true);
    expect(same({ note: '2026-11-03T05:01:00.789Z' }, { note: '2026-11-03T05:01:00Z' })).toBe(false); // free text is never touched
    expect(encodeRecord({ note: '2026-11-03T05:01:00.789Z' })).toContain('.789Z');
  });

  it('keeps accents and emoji as they are', () => {
    const line = encodeRecord({ name: 'Gorkhey – Samanden 🏔', note: 'नमस्ते' });
    expect(JSON.parse(line)).toEqual({ name: 'Gorkhey – Samanden 🏔', note: 'नमस्ते' });
  });
});

// ---- Ids, dates and display

describe('ids and dates', () => {
  it('makes upper-case UUIDs', () => {
    const id = newId();
    expect(id).toBe(id.toUpperCase());
    expect(isId(id)).toBe(true);
    expect(id[14]).toBe('4');
    expect(new Set(Array.from({ length: 200 }, newId)).size).toBe(200);
    expect(isId('nope')).toBe(false);
    expect(isId(5)).toBe(false);
  });

  it('writes and reads instants to the second', () => {
    expect(toInstant(1_700_000_000_999)).toBe('2023-11-14T22:13:20Z');
    expect(parseInstant('2023-11-14T22:13:20.5Z')).toBe('2023-11-14T22:13:20Z');
    expect(parseInstant('2023-11-14')).toBeNull();
    expect(parseInstant(5)).toBeNull();
    expect(nowSecond()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('turns a date field into local midnight and back', () => {
    expect(fromDayKey('2026-11-20')).toBe('2026-11-19T18:30:00Z'); // India is UTC+5:30
    expect(dayKey('2026-11-19T18:30:00Z')).toBe('2026-11-20');
    expect(fromDayKey('20/11/2026')).toBeUndefined();
    expect(stampKey('2026-11-03T05:00:00Z')).toBe('2026-11-03 10:30');
    expect(startOfDay('2026-11-03T20:00:00Z').getDate()).toBe(4); // 1:30 am on the 4th in India
    expect(addDays(new Date(2026, 10, 30), 1).getMonth()).toBe(11);
  });

  it('formats dates like the other apps', () => {
    expect(fmtDate(new Date(2026, 10, 3))).toBe('3 Nov 2026');
    expect(fmtDateTime('2026-11-03T13:00:00Z')).toBe('3 Nov 2026, 6:30 pm');
    expect(fmtDateTime('2026-11-03T18:30:00Z')).toBe('4 Nov 2026, 12:00 am');
    const t = makeTrek({ name: 'K', durationDays: 4, difficulty: 'Hard', startDate: date(2026, 11, 20) });
    expect(trekSummary(t)).toBe('20 Nov 2026 to 23 Nov 2026 · 4 days · Hard');
    expect(trekSummary(makeTrek({ name: 'U', durationDays: 2 }))).toBe('2 days · Moderate');
    expect(trekEndDate(makeTrek({ name: 'x', durationDays: 0, startDate: date(2026, 11, 20) }))!.getDate()).toBe(20);
  });
});

// ---- Storage

describe('storage', () => {
  it('moves an unreadable saved list aside instead of overwriting it', () => {
    const kv = new MemoryKV();
    kv.set('pahadi.treks', '{this is not json');
    const store = new TrekStore(kv, () => []);
    expect(store.treks).toEqual([]);
    const aside = [...kv.map.keys()].filter((k) => k.startsWith('pahadi.treks.unreadable-'));
    expect(aside.length).toBe(1);
    expect(kv.get(aside[0])).toBe('{this is not json');
  });

  it('does the same when a single record cannot be read', () => {
    const kv = new MemoryKV();
    const raw = '[{"id":"11111111-1111-1111-1111-111111111111","name":"Fine"},{"id":"bad"}]';
    kv.set('pahadi.ledger', raw);
    const ledger = new LedgerStore(kv);
    expect(ledger.entries).toEqual([]);
    expect([...kv.map.entries()].some(([k, v]) => k.startsWith('pahadi.ledger.unreadable-') && v === raw)).toBe(true);
  });

  it('copes with a list that is not a list', () => {
    const kv = new MemoryKV();
    kv.set('pahadi.vendors', '{"a":1}');
    expect(new VendorStore(kv).vendors).toEqual([]);
    kv.set('pahadi.guidance', '5');
    expect(new GuidanceStore(kv).rules).toEqual([]);
    kv.set('pahadi.bookings', 'null');
    expect(new BookingStore(kv).bookings).toEqual([]);
  });

  it('keeps working in memory when saving fails', () => {
    const kv = new MemoryKV();
    kv.failWrites = true;
    const store = new TrekStore(kv, () => []);
    store.upsert(makeTrek({ name: 'Unsaved' }));
    expect(store.treks.map((t) => t.name)).toEqual(['Unsaved']);
    expect(kv.map.size).toBe(0);
  });

  it('tells screens when something changed', () => {
    const store = new TrekStore(new MemoryKV(), () => []);
    const seen: number[] = [];
    const off = store.subscribe(() => seen.push(store.rev));
    store.upsert(makeTrek({ name: 'A' }));
    store.upsert(makeTrek({ name: 'B' }));
    off();
    store.upsert(makeTrek({ name: 'C' }));
    expect(seen).toEqual([1, 2]);
    expect(store.treks.length).toBe(3);
  });

  it('does not tell screens when a merge changes nothing', () => {
    const store = new TrekStore(new MemoryKV(), () => []);
    store.upsert(makeTrek({ name: 'A' }));
    let n = 0;
    store.subscribe(() => n++);
    store.applyMerged(store.syncRecords);
    expect(n).toBe(0);
  });

  it('survives localStorage throwing', () => {
    const quota = () => { throw new DOMException('full', 'QuotaExceededError'); };
    vi.stubGlobal('localStorage', { getItem: quota, setItem: quota, removeItem: quota });
    const kv = new LocalKV();
    let changes = 0;
    kv.onChange(() => changes++);
    expect(kv.get('x')).toBeNull();
    expect(kv.set('x', 'y')).toBe(false);
    expect(kv.writeFailed).toBe(true);
    expect(changes).toBe(1);
    kv.set('x', 'z');
    expect(changes).toBe(1); // told once
    expect(() => kv.remove('x')).not.toThrow();
  });

  it('recovers when saving works again', () => {
    const data = new Map<string, string>();
    let broken = true;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { if (broken) throw new Error('full'); data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    });
    const kv = new LocalKV();
    kv.set('a', '1');
    expect(kv.writeFailed).toBe(true);
    broken = false;
    expect(kv.set('a', '1')).toBe(true);
    expect(kv.writeFailed).toBe(false);
    expect(kv.get('a')).toBe('1');
  });

  it('keeps the two secrets apart from everything else', () => {
    const kv = new MemoryKV();
    const s = new Secrets(kv);
    s.setGeminiKey('  AIza-test  ');
    s.setSyncSecret('s3cret');
    expect(s.geminiKey).toBe('AIza-test');
    expect(s.syncSecret).toBe('s3cret');
    s.setGeminiKey('  ');
    expect(s.geminiKey).toBeNull();
    expect([...kv.map.keys()].filter((k) => k.startsWith('pahadi.secret.')).sort()).toEqual(['pahadi.secret.sync']);
  });

  it('puts nothing secret in any saved list', () => {
    const app = new AppContainer(new MemoryKV());
    app.secrets.setGeminiKey('AIza-SECRET-KEY');
    app.secrets.setSyncSecret('SYNC-SECRET');
    app.settings.setSyncUrl(ADDRESS);
    app.treks.upsert(makeTrek({ name: 'T' }));
    for (const [k, v] of (app.kv as MemoryKV).map) {
      if (k.startsWith('pahadi.secret.') || k === 'pahadi.settings') continue;
      expect(v, k).not.toContain('SECRET');
    }
  });
});

describe('app container', () => {
  it('settles seats once at start', () => {
    const kv = new MemoryKV();
    const first = new AppContainer(kv);
    const t = { ...makeTrek({ name: 'K', startDate: date(2030, 1, 1), seatsLeft: 5 }), seatCapacity: 5 };
    first.treks.upsert(t);
    first.bookings.confirm({ trekID: t.id, travellers: ['A', 'B'], phone: '', trekStore: first.treks });
    // Someone edits the trek's seats by hand, out of step with the bookings; a restart puts it right.
    first.treks.adjustSeats(t.id, 4);
    expect(first.treks.trek(t.id)!.seatsLeft).toBe(7);
    const second = new AppContainer(kv);
    expect(second.treks.trek(t.id)!.seatsLeft).toBe(3);
  });

  it('names the device for the sheet log', () => {
    const app = new AppContainer(new MemoryKV());
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    expect(app.deviceName).toBe('Web (iPhone)');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' });
    expect(app.deviceName).toBe('Web (Android)');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' });
    expect(app.deviceName).toBe('Web');
  });

  it('merges nothing into nothing', () => {
    const { data, report } = mergeData(emptyData(), emptyData());
    expect(report).toEqual({ received: 0, sent: 0, overbooked: [] });
    expect(data.treks).toEqual([]);
  });
});

describe('sync list helpers', () => {
  it('leaves records that never had a stamp as the oldest', () => {
    const t = makeTrek({ name: 'x' });
    expect(SyncList.stampMissing([t], at(2026, 1, 1))![0].updatedAt).toBe(at(2026, 1, 1));
    expect(SyncList.stampMissing([{ ...t, updatedAt: at(2026, 1, 1) }], at(2027, 1, 1))).toBeNull();
  });
});

// ---- Gemini over fetch

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const text = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

function streamResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
  return new Response(body, { status });
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('gemini over fetch', () => {
  const client = new GeminiClient();
  const history = [{ role: 'user' as const, text: 'hi' }];

  it('streams text split across network chunks, even in the middle of a line or a character', async () => {
    const full = sse(text('Hello '), text('wörld 🏔'));
    const bytes = new TextEncoder().encode(full);
    // Cut the bytes at awkward places (inside a line and inside a multi-byte character).
    const cuts = [7, 30, bytes.length - 9, bytes.length - 3];
    const pieces: Uint8Array[] = [];
    let prev = 0;
    for (const c of [...cuts, bytes.length]) { pieces.push(bytes.slice(prev, c)); prev = c; }
    const body = new ReadableStream<Uint8Array>({ start(c) { pieces.forEach((p) => c.enqueue(p)); c.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const events = await collect(client.stream('KEY', 'gemini-flash-latest', 'sys', history));
    expect(events).toEqual([{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'wörld 🏔' }]);
  });

  it('sends the key in a header, never in the URL', async () => {
    const fetchMock = vi.fn(async () => streamResponse([sse(text('ok'))]));
    vi.stubGlobal('fetch', fetchMock);
    await collect(client.stream('SECRET', 'gemini-flash-latest', 'sys', history));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('SECRET');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('SECRET');
    expect(init.credentials).toBe('omit');
  });

  it('falls back to the next model when the first is busy', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"overloaded"}}', { status: 503 }))
      .mockResolvedValueOnce(streamResponse([sse(text('from lite'))]));
    vi.stubGlobal('fetch', fetchMock);
    const events = await collect(client.stream('K', 'gemini-flash-latest', 'sys', history));
    expect(events).toEqual([{ type: 'text', text: 'from lite' }]);
    expect(fetchMock.mock.calls.map((c) => c[0] as string)).toEqual([
      expect.stringContaining('models/gemini-flash-latest:'), expect.stringContaining('models/gemini-flash-lite-latest:'),
    ]);
  });

  it('does not fall back on a bad request or a bad key', async () => {
    for (const status of [400, 403]) {
      const fetchMock = vi.fn(async () => new Response(`{"error":{"message":"nope ${status}"}}`, { status }));
      vi.stubGlobal('fetch', fetchMock);
      const e = (await failure(collect(client.stream('K', 'gemini-flash-latest', 'sys', history)))) as GeminiError;
      expect(e.message).toBe(`Gemini error ${status}: nope ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('does not fall back once part of a reply has arrived', async () => {
    const enc = new TextEncoder();
    let pulls = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(c) { if (pulls++ === 0) c.enqueue(enc.encode(sse(text('Part')))); else c.error(new TypeError('network lost')); },
    });
    const fetchMock = vi.fn(async () => new Response(broken));
    vi.stubGlobal('fetch', fetchMock);
    const got: unknown[] = [];
    let err: unknown;
    try { for await (const e of client.stream('K', 'gemini-flash-latest', 'sys', history)) got.push(e); } catch (e) { err = e; }
    expect(got).toEqual([{ type: 'text', text: 'Part' }]);
    expect(codeOf(err)).toBeUndefined();
    expect(err).toBeInstanceOf(GeminiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up with the last error when every model fails', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"busy"}}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const e = (await failure(collect(client.stream('K', 'gemini-flash-latest', 'sys', history)))) as GeminiError;
    expect(e.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a lost connection in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    vi.stubGlobal('navigator', { onLine: true });
    const e = (await failure(collect(client.stream('K', 'm1', 'sys', history)))) as GeminiError;
    expect(e.code).toBe('network');
    expect(e.message).toContain('Check your connection');
  });

  it('stops quietly when cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    const ctl = new AbortController();
    const run = collect(client.stream('K', 'm1', 'sys', history, ctl.signal));
    ctl.abort();
    const e = await failure(run);
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe('AbortError');
  });

  it('rejects a bad model name before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const e = (await failure(collect(client.stream('K', '../evil?x=1', 'sys', history)))) as GeminiError;
    expect(e.code).toBe('invalidModel');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests a key with a cheap call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await client.testKey('KEY');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models?pageSize=1');
    expect(url).not.toContain('KEY');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"API key not valid"}}', { status: 400 })));
    expect(((await failure(client.testKey('bad'))) as Error).message).toBe('Gemini error 400: API key not valid');
  });
});

