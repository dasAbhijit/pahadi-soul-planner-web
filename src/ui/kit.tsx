import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dayKey, fromDayKey, type Instant } from '../core/ids';
import { nav } from './router';

/** Shared building blocks, the web twins of the Android Theme.kt and Common.kt pieces. */

export function Card(p: { children: ComponentChildren; onClick?: () => void; class?: string }) {
  return (
    <div class={`card ${p.onClick ? 'tap' : ''} ${p.class ?? ''}`} onClick={p.onClick} role={p.onClick ? 'button' : undefined}>
      {p.children}
    </div>
  );
}

export function Chip(p: { text: string; tone?: 'green' | 'amber' | 'rust' | 'neutral' }) {
  const tone = p.tone && p.tone !== 'green' ? p.tone : '';
  return <span class={`chip ${tone}`}>{p.text}</span>;
}

export function InfoNote(p: { children: ComponentChildren; tone?: 'info' | 'warn' | 'err' }) {
  return (
    <div class={`note ${p.tone === 'warn' ? 'warn' : p.tone === 'err' ? 'err' : ''}`}>
      <span class="i">{p.tone === 'err' || p.tone === 'warn' ? '!' : 'i'}</span>
      <div class="grow">{p.children}</div>
    </div>
  );
}

export const SectionLabel = (p: { children: ComponentChildren }) => <div class="section-label">{p.children}</div>;
export const FieldLabel = (p: { children: ComponentChildren }) => <div class="field-label">{p.children}</div>;

export function PrimaryButton(p: { text: string; onClick: () => void; disabled?: boolean }) {
  return <button class="btn" type="button" onClick={p.onClick} disabled={p.disabled}>{p.text}</button>;
}

export function OutlineButton(p: { text: string; onClick: () => void; disabled?: boolean; danger?: boolean; block?: boolean; small?: boolean }) {
  return (
    <button class={`btn outline ${p.danger ? 'danger' : ''} ${p.block ? 'block' : ''} ${p.small ? 'small' : ''}`} type="button" onClick={p.onClick} disabled={p.disabled}>
      {p.text}
    </button>
  );
}

export function LinkButton(p: { text: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return <button class={`btn link ${p.danger ? 'danger' : ''}`} type="button" onClick={p.onClick} disabled={p.disabled}>{p.text}</button>;
}

/** A text box with its label above it. */
export function Field(p: {
  label?: string; value: string; onChange: (v: string) => void; placeholder?: string; numeric?: boolean; phone?: boolean;
  disabled?: boolean; multiline?: boolean; rows?: number; password?: boolean; words?: boolean; maxLength?: number; hint?: string;
  type?: string; onEnter?: () => void; autoFocus?: boolean;
}) {
  const common = {
    value: p.value, placeholder: p.placeholder, disabled: p.disabled, maxLength: p.maxLength, autoFocus: p.autoFocus,
    autoComplete: 'off', autoCorrect: 'off', spellcheck: false,
    onInput: (e: Event) => p.onChange((e.target as HTMLInputElement).value),
  };
  return (
    <label class="field">
      {p.label ? <FieldLabel>{p.label}</FieldLabel> : null}
      {p.multiline ? (
        <textarea class="textarea" rows={p.rows ?? 4} {...common} autoCapitalize={p.words ? 'words' : 'sentences'} />
      ) : (
        <input
          class="input" {...common}
          type={p.password ? 'password' : p.type ?? (p.numeric ? 'text' : p.phone ? 'tel' : 'text')}
          inputMode={p.numeric ? 'numeric' : p.phone ? 'tel' : undefined}
          pattern={p.numeric ? '[0-9]*' : undefined}
          autoCapitalize={p.words ? 'words' : 'none'}
          enterkeyhint="done"
          onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); p.onEnter?.(); } }}
        />
      )}
      {p.hint ? <div class="tiny muted">{p.hint}</div> : null}
    </label>
  );
}

/** A number box that holds digits only. `value` is the text so an empty box stays empty. */
export function digitsOnly(s: string): string { return s.replace(/[^0-9]/g, ''); }

/** Segmented control, like the iPhone one. */
export function Segmented<T extends string>(p: { options: { value: T; label: string }[]; selected: T; onSelect: (v: T) => void }) {
  return (
    <div class="seg" role="tablist">
      {p.options.map((o) => (
        <button type="button" key={o.value} class={o.value === p.selected ? 'on' : ''} onClick={() => p.onSelect(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A row with a title on the left and the current choice on the right; tapping opens the phone's own picker. */
export function PickerRow<T extends string>(p: { title: string; value: string; options: { value: T; label: string }[]; onSelect: (v: T) => void }) {
  const idx = p.options.findIndex((o) => o.label === p.value);
  return (
    <div class="pickrow">
      <span style="font-size:14px;font-weight:500">{p.title}</span>
      <span class="spacer" />
      <span class="v">{p.value} ▾</span>
      <select aria-label={p.title} value={idx >= 0 ? String(idx) : ''} onChange={(e) => p.onSelect(p.options[Number((e.target as HTMLSelectElement).value)].value)}>
        {p.options.map((o, i) => <option key={o.value} value={String(i)}>{o.label}</option>)}
      </select>
    </div>
  );
}

/** A labelled drop-down that looks like a text box. */
export function SelectField<T extends string>(p: { label?: string; value: T | ''; options: { value: T; label: string }[]; onSelect: (v: T) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <label class="field">
      {p.label ? <FieldLabel>{p.label}</FieldLabel> : null}
      <select class="select" disabled={p.disabled} value={p.value} onChange={(e) => p.onSelect((e.target as HTMLSelectElement).value as T)}>
        {p.placeholder !== undefined ? <option value="">{p.placeholder}</option> : null}
        {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** A date box. Holds a whole day, stored as local midnight. */
export function DateField(p: { label?: string; value: Instant | undefined; onChange: (v: Instant | undefined) => void; min?: Instant; clearable?: boolean }) {
  return (
    <label class="field">
      {p.label ? <FieldLabel>{p.label}</FieldLabel> : null}
      <div class="row">
        <input
          class="input" type="date" value={p.value ? dayKey(p.value) : ''} min={p.min ? dayKey(p.min) : undefined}
          onInput={(e) => p.onChange(fromDayKey((e.target as HTMLInputElement).value))}
        />
        {p.clearable && p.value ? <LinkButton text="Clear" onClick={() => p.onChange(undefined)} /> : null}
      </div>
    </label>
  );
}

export function SwitchRow(p: { title: string; subtitle?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="switchrow">
      <div class="grow">
        <div style="font-size:14px;font-weight:500">{p.title}</div>
        {p.subtitle ? <div class="tiny muted">{p.subtitle}</div> : null}
      </div>
      <button type="button" class="switch" role="switch" aria-checked={p.checked} aria-label={p.title} onClick={() => p.onChange(!p.checked)} />
    </div>
  );
}

export function ChoiceRow(p: { label: string; sub?: string; selected: boolean; multi?: boolean; onClick: () => void }) {
  return (
    <button type="button" class={`choice ${p.selected ? 'on' : ''}`} onClick={p.onClick}>
      <span class={`mark ${p.multi ? 'box' : 'radio'}`}>{p.selected ? '✓' : ''}</span>
      <span class="grow">
        <div style="font-size:15px;font-weight:500">{p.label}</div>
        {p.sub ? <div class="tiny muted">{p.sub}</div> : null}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ Pages

/** A screen with a header. `tab` screens show the title big and no back arrow. */
export function Page(p: { title: string; tab?: boolean; trailing?: ComponentChildren; children: ComponentChildren; flush?: boolean; footer?: ComponentChildren; onBack?: () => void }) {
  return (
    <>
      <header class={`page-head ${p.tab ? 'tab' : ''}`}>
        {p.tab ? null : <button class="iconbtn" type="button" aria-label="Back" onClick={p.onBack ?? nav.back}>‹</button>}
        <h1>{p.title}</h1>
        {p.trailing ? <div class="trail">{p.trailing}</div> : null}
      </header>
      <main class={`body ${p.flush ? 'flush' : ''}`}>{p.children}</main>
      {p.footer ? <div class="footer-bar">{p.footer}</div> : null}
    </>
  );
}

/** A form screen: Cancel/Back at the top and a Save bar at the bottom. */
export function FormPage(p: { title: string; saveLabel?: string; canSave?: boolean; onSave: () => void; children: ComponentChildren; error?: string | null }) {
  return (
    <Page title={p.title} footer={<PrimaryButton text={p.saveLabel ?? 'Save'} onClick={p.onSave} disabled={p.canSave === false} />}>
      {p.error ? <InfoNote tone="err">{p.error}</InfoNote> : null}
      {p.children}
    </Page>
  );
}

// ------------------------------------------------------------------ Dialogs

/** A modal. Tapping the dark area closes it. `sheet` slides it up from the bottom. */
export function Modal(p: { title?: string; children: ComponentChildren; onClose: () => void; sheet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [p.onClose]);
  return (
    <div class={`scrim ${p.sheet ? 'sheet-scrim' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div class={`dialog ${p.sheet ? 'sheet' : ''}`} role="dialog" aria-modal="true" ref={ref}>
        {p.title ? <h2>{p.title}</h2> : null}
        {p.children}
      </div>
    </div>
  );
}

export function AlertBox(p: { title: string; text: string; onDismiss: () => void }) {
  return (
    <Modal title={p.title} onClose={p.onDismiss}>
      <div class="pre break">{p.text}</div>
      <div class="actions"><LinkButton text="OK" onClick={p.onDismiss} /></div>
    </Modal>
  );
}

export function Confirm(p: { title: string; message: string; confirmLabel: string; cancelLabel?: string; danger?: boolean; onConfirm: () => void; onDismiss: () => void }) {
  return (
    <Modal title={p.title} onClose={p.onDismiss}>
      <div class="pre break">{p.message}</div>
      <div class="actions">
        <LinkButton text={p.cancelLabel ?? 'Cancel'} onClick={p.onDismiss} />
        <LinkButton text={p.confirmLabel} danger={p.danger} onClick={() => { p.onDismiss(); p.onConfirm(); }} />
      </div>
    </Modal>
  );
}

/** A short message at the bottom of the screen that goes away by itself. */
export function useToast(): [JSX.Element | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const t = setTimeout(() => setText(null), 2600);
    return () => clearTimeout(t);
  }, [text]);
  return [text === null ? null : <div class="toast" role="status">{text}</div>, setText];
}

export function EmptyState(p: { emoji?: string; title: string; text?: string }) {
  return (
    <div class="empty">
      {p.emoji ? <div class="em">{p.emoji}</div> : null}
      <div class="bold" style="color:var(--ink)">{p.title}</div>
      {p.text ? <div class="small">{p.text}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Files

/**
 * Hands a file to the person. On a phone this opens the share sheet (Save to Files, Google Drive, WhatsApp);
 * elsewhere it downloads. Must be called from a tap.
 */
export async function saveFile(name: string, mime: string, text: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([text], name, { type: mime });
  const nv = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nv.canShare && nv.canShare({ files: [file] }) && typeof nv.share === 'function') {
    try { await nv.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'; /* fall back to a download */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

/** Opens the phone's file picker and returns the text of the chosen file, or null if none was chosen. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
