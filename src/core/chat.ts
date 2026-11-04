import { AppError } from './errors';
import { GeminiClient, type GeminiMessage, type GeminiRole, type Streamer } from './gemini';
import { buildPrompt } from './prompt';
import { newId, type Id } from './ids';
import { Observable } from './storage';
import type { GuidanceStore, TrekStore, VendorStore } from './stores';
import type { Secrets, SettingsStore } from './settings';

export type ProposalState = 'pending' | 'applied' | 'dismissed';
export interface Proposal { text: string; state: ProposalState }
export interface ChatMessage { id: Id; role: GeminiRole; text: string; isError?: boolean; proposal?: Proposal }

export const PROPOSAL_INTRO = "Got it. Here's the rule I'd save:";
export const NO_KEY_MESSAGE = 'Add your Gemini API key in Settings first.';

/**
 * Chat state and the Gemini round trip. The key lookup and the stream are injectable so the whole flow
 * can be tested without a network.
 */
export class Chat extends Observable {
  messages: ChatMessage[] = [];
  brief = '';
  isSending = false;
  private abort: AbortController | null = null;

  constructor(
    private settings: SettingsStore, private treks: TrekStore, private guidance: GuidanceStore, private vendors: VendorStore,
    private secrets: Secrets, private streamer: Streamer = (k, m, s, h, sig) => new GeminiClient().stream(k, m, s, h, sig),
  ) { super(); }

  get hasKey(): boolean { return this.secrets.geminiKey !== null; }

  setBrief(v: string) { this.brief = v; this.emit(); }

  newChat() {
    this.abort?.abort();
    this.abort = null;
    this.messages = [];
    this.isSending = false;
    this.emit();
  }

  /** Stops a reply that is still arriving. What has arrived so far stays. */
  stop() { this.abort?.abort(); }

  async send(raw: string, now = new Date()): Promise<void> {
    const text = raw.trim();
    if (text === '' || this.isSending) return;
    this.messages = [...this.messages, { id: newId(), role: 'user', text }];

    const key = this.secrets.geminiKey;
    if (key === null) {
      this.messages = [...this.messages, { id: newId(), role: 'model', text: NO_KEY_MESSAGE, isError: true }];
      this.emit();
      return;
    }

    const replyID = newId();
    this.messages = [...this.messages, { id: replyID, role: 'model', text: '' }];
    const history: GeminiMessage[] = this.messages
      .filter((m) => !m.isError && m.id !== replyID && m.text !== '')
      .map((m) => ({ role: m.role, text: m.text }));
    const system = buildPrompt({
      basePrompt: this.settings.systemPrompt, treks: this.treks.treks, vendors: this.vendors.vendors,
      guidance: this.guidance.rules.map((r) => r.text), clientBrief: this.brief, now,
    });
    const model = this.settings.model;

    this.isSending = true;
    const ctl = new AbortController();
    this.abort = ctl;
    this.emit();
    try {
      for await (const ev of this.streamer(key, model, system, history, ctl.signal)) {
        this.edit(replyID, (m) => ev.type === 'text'
          ? { ...m, text: m.text + ev.text }
          : { ...m, proposal: { text: ev.rule, state: 'pending' }, text: m.text.trim() === '' ? PROPOSAL_INTRO : m.text });
      }
      this.finish(replyID, null);
    } catch (e) {
      this.finish(replyID, e);
    } finally {
      if (this.abort === ctl) this.abort = null;
    }
  }

  /** Saves the proposed rule. Returns an error message if it was rejected. */
  applyProposal(messageID: Id, text: string): string | null {
    try {
      this.guidance.add(text);
      this.setProposalState('applied', messageID);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'That rule could not be saved.';
    }
  }

  dismissProposal(messageID: Id) { this.setProposalState('dismissed', messageID); }

  private setProposalState(state: ProposalState, id: Id) {
    this.edit(id, (m) => (m.proposal ? { ...m, proposal: { ...m.proposal, state } } : m));
  }

  private edit(id: Id, change: (m: ChatMessage) => ChatMessage) {
    this.messages = this.messages.map((m) => (m.id === id ? change(m) : m));
    this.emit();
  }

  private finish(id: Id, error: unknown) {
    this.isSending = false;
    const m = this.messages.find((x) => x.id === id);
    if (!m) { this.emit(); return; }
    const empty = m.text === '' && !m.proposal;
    const stopped = error instanceof DOMException && error.name === 'AbortError';
    if (error && !stopped) {
      const msg = error instanceof Error && error.message ? error.message : 'Something went wrong.';
      if (empty) this.edit(id, () => ({ id, role: 'model', text: msg, isError: true }));
      else { this.messages = [...this.messages, { id: newId(), role: 'model', text: msg, isError: true }]; this.emit(); }
    } else if (empty) {
      this.edit(id, (x) => ({ ...x, text: stopped ? 'Stopped.' : 'No reply came back. Try again.', isError: true }));
    } else this.emit();
  }
}

export { AppError };
