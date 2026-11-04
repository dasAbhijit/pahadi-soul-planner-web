import './helpers';
import { describe, expect, it } from 'vitest';
import { Chat, NO_KEY_MESSAGE, PROPOSAL_INTRO } from '../src/core/chat';
import { GeminiError, type GeminiEvent, type GeminiMessage } from '../src/core/gemini';
import { Secrets, SettingsStore } from '../src/core/settings';
import { GuidanceStore, TrekStore, VendorStore } from '../src/core/stores';
import { MemoryKV } from '../src/core/storage';
import { makeTrek, makeVendor } from '../src/core/models';

class Harness {
  kv = new MemoryKV();
  treks = new TrekStore(this.kv, () => []);
  guidance = new GuidanceStore(this.kv);
  vendors = new VendorStore(this.kv);
  settings = new SettingsStore(this.kv);
  secrets = new Secrets(this.kv);
  captured: { model: string; system: string; history: GeminiMessage[] } | null = null;
  calls = 0;

  chat(key: string | null = 'KEY', events: () => AsyncIterable<GeminiEvent> = () => stream([{ type: 'text', text: 'Hi' }])): Chat {
    this.secrets.setGeminiKey(key);
    return new Chat(this.settings, this.treks, this.guidance, this.vendors, this.secrets, (_k, model, system, history) => {
      this.calls++;
      this.captured = { model, system, history };
      return events();
    });
  }
}

async function* stream(events: GeminiEvent[], then?: Error): AsyncGenerator<GeminiEvent> {
  for (const e of events) yield e;
  if (then) throw then;
}

describe('chat', () => {
  it('shows an error and never calls Gemini when there is no key', async () => {
    const h = new Harness();
    const chat = h.chat(null);
    await chat.send('hello');
    expect(chat.messages.length).toBe(2);
    expect(chat.messages[1].isError).toBe(true);
    expect(chat.messages[1].text).toBe(NO_KEY_MESSAGE);
    expect(h.calls).toBe(0);
  });

  it('builds one reply from streamed text, and the prompt carries the catalogue', async () => {
    const h = new Harness();
    h.treks.upsert(makeTrek({ name: 'Gorkhey', startDate: new Date(Date.now() + 86_400_000 * 10).toISOString().replace(/\.\d+Z$/, 'Z'), seatsLeft: 4 }));
    h.vendors.upsert(makeVendor({ name: 'Dorje', service: 'Guide' }));
    const chat = h.chat('KEY', () => stream([{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }]));
    chat.setBrief('2 adults');
    await chat.send('  Pitch me a trek  ');
    expect(chat.messages.map((m) => m.text)).toEqual(['Pitch me a trek', 'Hello there']);
    expect(chat.isSending).toBe(false);
    const { model, system, history } = h.captured!;
    expect(model).toBe('gemini-flash-latest');
    expect(system).toContain('Gorkhey');
    expect(system).toContain('Dorje');
    expect(system).toContain('2 adults');
    expect(history.map((m) => m.text)).toEqual(['Pitch me a trek']);
  });

  it('does not send earlier errors back to Gemini', async () => {
    const h = new Harness();
    await h.chat(null).send('first'); // error, no call
    const chat = h.chat();
    await chat.send('one');
    await chat.send('two');
    expect(h.captured!.history.map((m) => m.text)).toEqual(['one', 'Hi', 'two']);
  });

  it('lets a guidance proposal be applied or dismissed', async () => {
    const h = new Harness();
    const chat = h.chat('KEY', () => stream([{ type: 'guidance', rule: 'Always mention the pickup point.' }]));
    await chat.send('From now on mention pickup');
    const reply = chat.messages.at(-1)!;
    expect(reply.text).toBe(PROPOSAL_INTRO); // empty reply gets the intro line
    expect(reply.proposal?.state).toBe('pending');
    expect(h.guidance.rules).toEqual([]); // nothing saved before Apply
    expect(chat.applyProposal(reply.id, 'Always mention the pickup point.')).toBeNull();
    expect(h.guidance.rules.length).toBe(1);
    expect(chat.messages.at(-1)!.proposal?.state).toBe('applied');
    // the same rule again is refused with a message
    expect(chat.applyProposal(reply.id, 'always mention the pickup point.')).toBe('That rule is already saved.');

    const chat2 = h.chat('KEY', () => stream([{ type: 'guidance', rule: 'Be brief.' }]));
    await chat2.send('x');
    chat2.dismissProposal(chat2.messages.at(-1)!.id);
    expect(chat2.messages.at(-1)!.proposal?.state).toBe('dismissed');
    expect(h.guidance.rules.length).toBe(1);
  });

  it('shows errors before and after text sensibly', async () => {
    const h = new Harness();
    const before = h.chat('KEY', () => stream([], new GeminiError('http', 'Gemini error 503: busy', 503)));
    await before.send('hi');
    expect(before.messages.length).toBe(2);
    expect(before.messages[1].isError).toBe(true);
    expect(before.messages[1].text).toBe('Gemini error 503: busy');

    const after = h.chat('KEY', () => stream([{ type: 'text', text: 'Partial' }], new GeminiError('http', 'Gemini error 500: boom', 500)));
    await after.send('hi');
    expect(after.messages.map((m) => m.text)).toEqual(['hi', 'Partial', 'Gemini error 500: boom']);
    expect(after.messages[2].isError).toBe(true);
  });

  it('says so when the stream is empty', async () => {
    const h = new Harness();
    const chat = h.chat('KEY', () => stream([]));
    await chat.send('hi');
    expect(chat.messages.at(-1)!.text).toBe('No reply came back. Try again.');
    expect(chat.messages.at(-1)!.isError).toBe(true);
  });

  it('clears everything on a new chat', async () => {
    const h = new Harness();
    const chat = h.chat();
    await chat.send('hi');
    chat.newChat();
    expect(chat.messages).toEqual([]);
    expect(chat.isSending).toBe(false);
  });

  it('keeps what has arrived when stopped', async () => {
    const h = new Harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const chat = h.chat('KEY', () => (async function* () {
      yield { type: 'text', text: 'Partial' } as GeminiEvent;
      await gate;
      throw new DOMException('cancelled', 'AbortError');
    })());
    const sending = chat.send('hi');
    await Promise.resolve();
    chat.stop();
    release();
    await sending;
    expect(chat.isSending).toBe(false);
    expect(chat.messages.map((m) => m.text)).toEqual(['hi', 'Partial']);
    expect(chat.messages[1].isError).toBeFalsy();
  });

  it('ignores a second send while one is running', async () => {
    const h = new Harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const chat = h.chat('KEY', () => (async function* () { await gate; yield { type: 'text', text: 'Done' } as GeminiEvent; })());
    const first = chat.send('one');
    await Promise.resolve();
    await chat.send('two'); // ignored
    release();
    await first;
    expect(h.calls).toBe(1);
    expect(chat.messages.map((m) => m.text)).toEqual(['one', 'Done']);
  });
});
