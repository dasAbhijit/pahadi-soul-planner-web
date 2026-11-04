import { useState } from 'preact/hooks';
import { fmtDate } from '../../core/fmt';
import { buildPrompt, DEFAULT_SYSTEM_PROMPT } from '../../core/prompt';
import { MAX_RULE_LENGTH, MAX_RULES } from '../../core/stores';
import type { GuidanceRule } from '../../core/models';
import { useApp, useStore } from '../hooks';
import { AlertBox, Card, Confirm, Field, InfoNote, LinkButton, Modal, OutlineButton, Page, PrimaryButton, Segmented } from '../kit';
import { useRoute } from '../router';
import './settings.css';

type Tab = 'base' | 'guidance';

export function PromptScreen() {
  const app = useApp();
  useStore(app.settings, app.guidance, app.treks, app.vendors, app.chat);
  const route = useRoute();
  const [tab, setTab] = useState<Tab>(route.query.get('tab') === 'guidance' ? 'guidance' : 'base');
  const [showPreview, setShowPreview] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // A rule being edited, or a new one (id null).
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = app.guidance.rules;
  const prompt = app.settings.systemPrompt;

  const saveRule = () => {
    if (!editing) return;
    try {
      if (editing.id === null) app.guidance.add(editing.text); else app.guidance.update(editing.id, editing.text);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That rule could not be saved.');
    }
  };

  return (
    <Page title="Assistant prompt">
      <Segmented<Tab>
        options={[{ value: 'base', label: 'Base instructions' }, { value: 'guidance', label: `Learned guidance · ${rules.length}` }]}
        selected={tab} onSelect={setTab}
      />
      {tab === 'base' ? (
        <>
          <textarea
            class="textarea" style="min-height:52dvh" value={prompt} aria-label="Base instructions" spellcheck={false}
            onInput={(e) => app.settings.setSystemPrompt((e.target as HTMLTextAreaElement).value)}
          />
          <InfoNote>Edits apply to the next message. The trek catalogue is added automatically after these instructions, with today's date.</InfoNote>
          <div class="btnrow">
            <PrimaryButton text="Preview full prompt" onClick={() => setShowPreview(true)} />
            <OutlineButton text="Reset to default" block onClick={() => setConfirmReset(true)} disabled={prompt === DEFAULT_SYSTEM_PROMPT} />
          </div>
        </>
      ) : (
        <>
          {rules.length === 0 ? (
            <div class="small muted">No learned rules yet. In the chat, tell the assistant how to work, for example: always mention the pickup point. It will propose a rule for you to apply. You can also add one here.</div>
          ) : null}
          {rules.map((r: GuidanceRule) => (
            <Card key={r.id} class="pad0">
              <div class="ruleline">
                <div class="grow">
                  <div style="font-size:15px" class="break">{r.text}</div>
                  <div class="tiny muted">Added {fmtDate(r.createdAt)}</div>
                </div>
                <LinkButton text="Edit" onClick={() => setEditing({ id: r.id, text: r.text })} />
                <LinkButton text="Remove" danger onClick={() => app.guidance.remove(r.id)} />
              </div>
            </Card>
          ))}
          <InfoNote>Rules are added after the base instructions. They never override the accuracy and safety rules. Up to {MAX_RULES} rules.</InfoNote>
          <OutlineButton text="Add a rule" block onClick={() => setEditing({ id: null, text: '' })} disabled={rules.length >= MAX_RULES} />
          <div class="btnrow">
            <OutlineButton text="Undo last change" block onClick={() => app.guidance.undo()} disabled={!app.guidance.canUndo} />
            <PrimaryButton text="Preview full prompt" onClick={() => setShowPreview(true)} />
          </div>
        </>
      )}

      {confirmReset ? (
        <Confirm
          title="Reset the base instructions to the default?" message="Your edits to the base instructions are replaced."
          confirmLabel="Reset to default" danger onDismiss={() => setConfirmReset(false)} onConfirm={() => app.settings.resetPrompt()}
        />
      ) : null}
      {error ? <AlertBox title="Can't save the rule" text={error} onDismiss={() => setError(null)} /> : null}
      {editing ? (
        <Modal title={editing.id === null ? 'Add a rule' : 'Edit rule'} onClose={() => setEditing(null)}>
          <Field value={editing.text} onChange={(t) => setEditing({ ...editing, text: t })} multiline rows={4} autoFocus />
          <div class={`tiny ${editing.text.length > MAX_RULE_LENGTH ? 'bad' : 'muted'}`}>{editing.text.length} of {MAX_RULE_LENGTH} characters</div>
          <div class="actions">
            <LinkButton text="Cancel" onClick={() => setEditing(null)} />
            <LinkButton text="Save" onClick={saveRule} />
          </div>
        </Modal>
      ) : null}
      {showPreview ? (
        <Modal title="Full prompt" onClose={() => setShowPreview(false)}>
          <div class="mono">
            {buildPrompt({ basePrompt: prompt, treks: app.treks.treks, vendors: app.vendors.vendors, guidance: rules.map((r) => r.text), clientBrief: app.chat.brief })}
          </div>
          <div class="actions"><LinkButton text="Done" onClick={() => setShowPreview(false)} /></div>
        </Modal>
      ) : null}
    </Page>
  );
}
