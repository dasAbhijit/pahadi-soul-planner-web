import { AppError } from './errors';
import {
  MAX_DRAFTS_PER_REPLY, applyDraft, choose, draftFromCall, draftNote, draftsAllowed, resolveDraft, toolDeclarations, trekRefs, vendorRefs, viewDraft,
  type ChoiceField, type Draft, type DraftDeps, type DraftView, type Refs,
} from './chatactions';
import { GeminiClient, type GeminiMessage, type GeminiRole, type Streamer } from './gemini';
import { buildPrompt } from './prompt';
import type { Role } from './roles';
import { toInstant } from './ids';
import { newId, type Id } from './ids';
import { Observable } from './storage';
import type { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from './stores';
import type { Secrets, SettingsStore } from './settings';

export type ProposalState = 'pending' | 'applied' | 'dismissed';
export interface Proposal { text: string; state: ProposalState }
export interface ChatMessage {
  id: Id; role: GeminiRole; text: string; isError?: boolean; proposal?: Proposal;
  /** Draft cards the assistant prepared in this reply. */
  drafts?: Draft[];
  /** What the app tells the assistant about earlier drafts. Sent with this message, never shown. */
  hidden?: string;
}

/** What chat actions need besides the chat itself: the stores a draft writes to, and who is signed in. */
export interface ChatActionDeps { bookings: BookingStore; ledger: LedgerStore; role: () => Role | undefined }
export const DRAFT_INTRO = 'Here is the draft for you to check.';

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
    private secrets: Secrets, private streamer: Streamer = (k, m, s, h, sig, t) => new GeminiClient().stream(k, m, s, h, sig, t),
    private actions?: ChatActionDeps,
  ) { super(); }

  private nextDraft = 1;
  private notes: string[] = [];

  /** Whether drafts are on for this person: the switch, the notice read, and somebody signed in with a role. */
  get actionsActive(): boolean {
    return this.actions !== undefined && this.actions.role() !== undefined && this.settings.chatActionsOn && this.settings.chatActionsNoticeSeen;
  }
  /** The notice about what goes to Gemini still has to be read before drafting starts. */
  get actionsNeedNotice(): boolean {
    return this.actions !== undefined && this.actions.role() !== undefined && this.settings.chatActionsOn && !this.settings.chatActionsNoticeSeen;
  }
  private get deps(): DraftDeps | undefined {
    return this.actions ? { treks: this.treks, bookings: this.actions.bookings, ledger: this.actions.ledger, vendors: this.vendors } : undefined;
  }

  get hasKey(): boolean { return this.secrets.geminiKey !== null; }

  setBrief(v: string) { this.brief = v; this.emit(); }

  newChat() {
    this.abort?.abort();
    this.abort = null;
    this.messages = [];
    this.isSending = false;
    this.nextDraft = 1;
    this.notes = [];
    this.emit();
  }

  /** Stops a reply that is still arriving. What has arrived so far stays. */
  stop() { this.abort?.abort(); }

  async send(raw: string, now = new Date()): Promise<void> {
    const text = raw.trim();
    if (text === '' || this.isSending) return;
    const hidden = this.notes.length > 0 ? `[App: ${this.notes.join(' ')}]` : undefined;
    this.notes = [];
    this.messages = [...this.messages, hidden ? { id: newId(), role: 'user', text, hidden } : { id: newId(), role: 'user', text }];

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
      .map((m) => ({ role: m.role, text: this.historyText(m) }));
    const tools = this.actionsActive ? toolDeclarations(this.actions!.role()) : [];
    const refs: Refs = this.actionsActive ? { treks: trekRefs(this.treks.treks, now), vendors: vendorRefs(this.vendors.vendors) } : { treks: [], vendors: [] };
    const system = buildPrompt({
      basePrompt: this.settings.systemPrompt, treks: this.treks.treks, vendors: this.vendors.vendors,
      guidance: this.guidance.rules.map((r) => r.text), clientBrief: this.brief, now, actionTools: tools.map((t) => t.name),
    });
    const model = this.settings.model;

    this.isSending = true;
    const ctl = new AbortController();
    this.abort = ctl;
    this.emit();
    try {
      for await (const ev of this.streamer(key, model, system, history, ctl.signal, tools)) {
        if (ev.type === 'draft') this.addDraft(replyID, ev.tool, ev.args, refs, now);
        else this.edit(replyID, (m) => ev.type === 'text'
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

  // ------------------------------------------------------------------------------------------ Drafts

  private historyText(m: ChatMessage): string {
    if (m.role === 'user') return m.hidden ? `${m.hidden}\n${m.text}` : m.text;
    const d = this.deps;
    if (!m.drafts || m.drafts.length === 0 || !d) return m.text;
    return `${m.text}\n[App: drafts shown to the user, not saved: ${m.drafts.map((x) => draftNote(x, d)).join('; ')}]`;
  }

  private addDraft(replyID: Id, tool: string, args: Record<string, unknown>, refs: Refs, now: Date) {
    const deps = this.deps;
    if (!deps || !this.actionsActive) return;
    // The role is checked here as well as in the tool list, so a tool the role was not offered cannot make a card.
    const parsed = draftFromCall(tool, args, refs, now);
    if (!parsed || !draftsAllowed(this.actions!.role()).includes(parsed.data.kind)) return;
    const current = this.messages.find((m) => m.id === replyID);
    if ((current?.drafts?.length ?? 0) >= MAX_DRAFTS_PER_REPLY) return;
    const draft: Draft = { id: `D${this.nextDraft++}`, data: parsed.data, state: 'pending' };
    resolveDraft(draft, deps);
    if (parsed.replaces) this.setDraftState(parsed.replaces, 'replaced', (x) => x.state === 'pending' && x.data.kind === draft.data.kind);
    this.edit(replyID, (m) => ({ ...m, drafts: [...(m.drafts ?? []), draft] }));
  }

  findDraft(draftID: string): Draft | undefined {
    for (const m of this.messages) { const d = m.drafts?.find((x) => x.id === draftID); if (d) return d; }
    return undefined;
  }

  private setDraftState(draftID: string, state: Draft['state'], when: (d: Draft) => boolean = () => true, extra: Partial<Draft> = {}) {
    this.messages = this.messages.map((m) => (m.drafts?.some((d) => d.id === draftID && when(d))
      ? { ...m, drafts: m.drafts.map((d) => (d.id === draftID ? { ...d, ...extra, state } : d)) } : m));
    this.emit();
  }

  private changeDraft(draftID: string, change: (d: Draft) => Draft) {
    this.messages = this.messages.map((m) => (m.drafts?.some((d) => d.id === draftID)
      ? { ...m, drafts: m.drafts.map((d) => (d.id === draftID ? change(d) : d)) } : m));
    this.emit();
  }

  /** What the card shows, from the phone's data as it is now. */
  viewDraft(draft: Draft, now = new Date()): DraftView | undefined {
    const deps = this.deps;
    return deps ? viewDraft(draft, deps, this.actions!.role(), now) : undefined;
  }

  /** Settles a choice the card asked for (which trek, which traveller, how it was paid). */
  chooseForDraft(draftID: string, field: ChoiceField, value: string) {
    const deps = this.deps;
    if (!deps) return;
    this.changeDraft(draftID, (d) => {
      if (d.state !== 'pending') return d;
      const data = choose(d.data, field, value);
      const next: Draft = { ...d, data, error: undefined };
      resolveDraft(next, deps);
      return next;
    });
  }

  /**
   * Saves the draft after checking it again against the phone's data as it is now, through the same code as the form.
   * Returns the reason when it did not save. Does nothing if the card was already approved, denied or replaced.
   * A card with a warning (a possible duplicate) is saved only when `anyway` is true.
   */
  approveDraft(draftID: string, anyway = false, now = new Date()): string | null {
    const deps = this.deps;
    const draft = this.findDraft(draftID);
    if (!deps || !draft || draft.state !== 'pending') return null;
    const role = this.actions!.role();
    const view = viewDraft(draft, deps, role, now);
    if (!view.canApprove) {
      const why = view.problems[0] ?? 'This draft cannot be saved yet.';
      this.changeDraft(draftID, (d) => ({ ...d, error: why }));
      return why;
    }
    if (view.needsAnyway && !anyway) return view.warnings[0];
    try {
      const done = applyDraft(draft, deps, role, now);
      this.setDraftState(draftID, 'applied', () => true, { result: done.text, recordIDs: done.recordIDs, error: undefined });
      this.notes.push(`${draftID} was approved and saved by the user.`);
      this.settings.logChatAction('approved', toInstant(now));
      return null;
    } catch (e) {
      const why = e instanceof Error ? e.message : 'The draft could not be saved.';
      this.changeDraft(draftID, (d) => ({ ...d, error: why }));
      return why;
    }
  }

  denyDraft(draftID: string, now = new Date()) {
    const draft = this.findDraft(draftID);
    if (!draft || draft.state !== 'pending') return;
    this.setDraftState(draftID, 'denied');
    this.notes.push(`${draftID} was denied by the user; nothing was saved. Do not offer it again unless asked.`);
    this.settings.logChatAction('denied', toInstant(now));
  }

  /** Called by a form that was opened with Edit, after it saved. The card then reads "Saved from the form". */
  draftSavedFromForm(draftID: string, text: string, now = new Date(), recordIDs?: Id[]) {
    const draft = this.findDraft(draftID);
    if (!draft || draft.state !== 'pending') return;
    this.setDraftState(draftID, 'saved', () => true, { result: text, recordIDs, error: undefined });
    this.notes.push(`${draftID} was edited and saved from the form by the user.`);
    this.settings.logChatAction('edited', toInstant(now));
  }

  /** Saves a proposed rule. Returns an error message if it was rejected. */
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
    if (m.text === '' && m.drafts && m.drafts.length > 0) { this.edit(id, (x) => ({ ...x, text: DRAFT_INTRO })); return; }
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
