import { useEffect, useRef, useState } from 'preact/hooks';
import { formatForWhatsApp, QUICK_PROMPTS, whatsAppUrl } from '../../core/whatsapp';
import type { ChatMessage, Proposal } from '../../core/chat';
import { useApp, useStore } from '../hooks';
import { AlertBox, Chip, FieldLabel, LinkButton, OutlineButton, Page, useToast } from '../kit';
import { nav } from '../router';
import { InlineMarkdown } from './Markdown';
import './chat.css';

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the older way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export function ChatScreen() {
  const app = useApp();
  const chat = useStore(app.chat, app.treks, app.guidance, app.secrets);
  const [input, setInput] = useState('');
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [toast, say] = useToast();
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const msgs = chat.messages;
  const last = msgs[msgs.length - 1];
  const upcoming = app.treks.upcoming().length;
  const rules = app.guidance.rules.length;

  // Keep the newest text in view as a reply streams in.
  useEffect(() => {
    const body = endRef.current?.closest('.body');
    if (body) body.scrollTop = body.scrollHeight;
  }, [msgs.length, last?.text, last?.proposal?.state]);

  // Grow the box with what is typed, up to a few lines.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [input]);

  const send = (text: string) => {
    if (chat.isSending || text.trim() === '') return;
    void chat.send(text);
    setInput('');
  };
  const canSend = !chat.isSending && input.trim() !== '';

  const footer = (
    <div class="chat-foot">
      {!chat.hasKey ? (
        <div class="keybar">
          <span class="grow">Add your Gemini key to start chatting.</span>
          <LinkButton text="Settings" onClick={() => nav.replace('/settings')} />
        </div>
      ) : null}
      <div class="chat-chips">
        {QUICK_PROMPTS.map((p) => (
          <button key={p.id} type="button" class="pillbtn" disabled={chat.isSending} onClick={() => send(p.text)}>{p.title}</button>
        ))}
      </div>
      <div class="chat-input">
        <textarea
          ref={boxRef} class="textarea" rows={1} value={input} placeholder="Ask about a trek, dates or a client…"
          autoCapitalize="sentences" aria-label="Message"
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input); } }}
        />
        {chat.isSending ? (
          <button type="button" class="sendbtn stop" aria-label="Stop" onClick={() => chat.stop()}>Stop</button>
        ) : (
          <button type="button" class="sendbtn" aria-label="Send" disabled={!canSend} onClick={() => send(input)}>➤</button>
        )}
      </div>
    </div>
  );

  return (
    <Page
      title="Pahadi Soul Planner" tab flush footer={footer}
      trailing={msgs.length > 0 ? <LinkButton text="New chat" onClick={() => chat.newChat()} /> : undefined}
    >
      <div class="chat-top">
        <div class="chat-status">
          <span class={`dot ${chat.hasKey ? '' : 'warn'}`} />
          <span>{!chat.hasKey ? 'No Gemini key yet' : `Gemini key saved · ${upcoming} upcoming · ${rules} learned rule${rules === 1 ? '' : 's'}`}</span>
        </div>
        <div class="chat-brief">
          <FieldLabel>Client</FieldLabel>
          <input
            class="input" value={chat.brief} placeholder="2 adults, first trek, mid-Dec, ₹10k" aria-label="Client brief"
            autoComplete="off" autoCorrect="off" enterkeyhint="done"
            onInput={(e) => chat.setBrief((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          {chat.brief !== '' ? <button type="button" class="iconbtn" aria-label="Clear client brief" onClick={() => chat.setBrief('')}>✕</button> : null}
        </div>
      </div>
      <div class="chat-msgs">
        {msgs.length === 0 ? (
          <div class="chat-intro">
            <div class="title">Ask about a trek or a client.</div>
            <div class="muted small">Fill in the Client line, then tap a suggestion below. Tell me how to work (for example, always mention the pickup point) and I'll offer to remember it.</div>
          </div>
        ) : null}
        {msgs.map((m, i) => (
          <MessageRow
            key={m.id} m={m} streaming={chat.isSending && i === msgs.length - 1}
            onCopy={async () => say((await copyText(formatForWhatsApp(m.text))) ? 'Copied' : "Couldn't copy. Select the text instead.")}
            onApply={(text) => setRuleError(chat.applyProposal(m.id, text))}
            onDismiss={() => chat.dismissProposal(m.id)}
          />
        ))}
        <div ref={endRef} />
      </div>
      {toast}
      {ruleError ? <AlertBox title="Couldn't save the rule" text={ruleError} onDismiss={() => setRuleError(null)} /> : null}
    </Page>
  );
}

function MessageRow(p: { m: ChatMessage; streaming: boolean; onCopy: () => void; onApply: (text: string) => void; onDismiss: () => void }) {
  const { m, streaming } = p;
  if (m.role === 'user') return <div class="msg-user">{m.text}</div>;
  return (
    <div class="msg-model">
      <div class={`bubble ${m.isError ? 'err' : ''}`}>
        {m.text === '' && streaming ? (
          <div class="row"><span class="spin" /><span class="muted small">Thinking…</span></div>
        ) : (
          <div class="text"><InlineMarkdown text={m.text} /></div>
        )}
        {m.proposal ? <ProposalCard p={m.proposal} onApply={p.onApply} onDismiss={p.onDismiss} /> : null}
      </div>
      {!m.isError && !streaming && m.text !== '' ? (
        <div class="msg-actions">
          <a class="pillbtn solid" href={whatsAppUrl(m.text)} target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
          <button type="button" class="pillbtn" onClick={p.onCopy}>Copy</button>
        </div>
      ) : null}
    </div>
  );
}

function ProposalCard(p: { p: Proposal; onApply: (text: string) => void; onDismiss: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.p.text);
  const { state, text } = p.p;
  return (
    <div class={`proposal ${state === 'pending' ? 'pending' : ''}`}>
      {state === 'pending' ? (
        <>
          <div><Chip text="PROPOSED RULE" tone="amber" /></div>
          {editing ? (
            <textarea class="textarea" rows={3} value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} aria-label="Rule text" />
          ) : (
            <div style="font-weight:500">{text}</div>
          )}
          <div class="row wrap">
            <button type="button" class="btn small" style="width:auto" onClick={() => p.onApply(editing ? draft : text)}>Apply</button>
            <OutlineButton small text={editing ? 'Undo edit' : 'Edit'} onClick={() => { if (editing) setEditing(false); else { setDraft(text); setEditing(true); } }} />
            <LinkButton text="Dismiss" onClick={p.onDismiss} />
          </div>
          <div class="tiny muted">Nothing changes until you tap Apply.</div>
        </>
      ) : state === 'applied' ? (
        <>
          <div class="row ok bold small"><span>✓</span><span>Saved to Learned guidance</span></div>
          <div class="small muted">{text}</div>
          <div><LinkButton text="View learned guidance" onClick={() => nav.go('/prompt?tab=guidance')} /></div>
        </>
      ) : (
        <div class="small muted">Dismissed</div>
      )}
    </div>
  );
}

