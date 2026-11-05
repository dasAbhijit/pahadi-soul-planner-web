import { useState } from 'preact/hooks';
import type { Draft } from '../../core/chatactions';
import { useApp, useStore } from '../hooks';
import { Chip, ChoiceRow, InfoNote, LinkButton, OutlineButton } from '../kit';
import { nav, to } from '../router';

/**
 * A draft the assistant prepared. It shows every field that would be saved. Only Approve writes, and what Approve
 * does is the same as the form. Edit opens the form with the fields filled in. Nothing here is saved by the assistant.
 */
export function DraftCard({ draft }: { draft: Draft }) {
  const app = useApp();
  useStore(app.chat, app.treks, app.bookings, app.ledger, app.account);
  const [note, setNote] = useState<string | null>(null);
  const { state } = draft;
  const view = state === 'pending' ? app.chat.viewDraft(draft) : undefined;
  const title = draft.data.kind === 'booking' ? 'booking' : 'payment';

  if (state === 'denied') return <div class="draft closed">Denied. Nothing was saved.</div>;
  if (state === 'replaced') return <div class="draft closed">Replaced by a newer draft. Nothing was saved.</div>;
  if (state === 'applied' || state === 'saved') {
    const trekID = draft.data.trekID;
    return (
      <div class="draft done" role="status">
        {state === 'saved'
          ? <><div class="row ok bold small"><span>✓</span><span>Saved from the form</span></div><div class="small">{draft.result}</div></>
          : <div class="row ok bold small"><span>✓</span><span>{draft.result}</span></div>}
        <div class="row wrap" style="gap:16px">
          {draft.data.kind === 'booking' && trekID ? <LinkButton text="Open booking" onClick={() => nav.go(to.trek(trekID))} /> : null}
          {draft.data.kind === 'paymentIn' ? <LinkButton text="View in Money" onClick={() => nav.go('/money')} /> : null}
        </div>
      </div>
    );
  }
  if (!view) return null;

  const approve = () => {
    const why = app.chat.approveDraft(draft.id, view.needsAnyway);
    setNote(why);
  };
  const edit = () => {
    if (draft.data.kind === 'booking') {
      if (draft.data.trekID) nav.go(to.addBooking(draft.data.trekID, draft.id));
    } else nav.go(to.entry({ kind: 'in', trek: draft.data.trekID, booking: draft.data.bookingID, draft: draft.id }));
  };
  const canEdit = draft.data.kind === 'paymentIn' || draft.data.trekID !== undefined;
  const shownProblem = view.choice === undefined ? view.problems[0] : undefined;

  return (
    <div class="draft pending" aria-label={`Draft ${title}`}>
      <div><Chip text={view.title} tone="amber" /></div>
      <div class="stack" style="gap:6px">
        {view.rows.map((r) => (
          <div class="drow" key={r.label}><span class="k">{r.label}</span><span class={r.strong ? 'bold' : ''}>{r.value}</span></div>
        ))}
      </div>
      {view.choice ? (
        <div class="stack" style="gap:6px">
          <div class="bold small">{view.choice.prompt}</div>
          {view.choice.options.map((o) => (
            <ChoiceRow key={o.value} label={o.label} sub={o.detail} selected={false} onClick={() => app.chat.chooseForDraft(draft.id, view.choice!.field, o.value)} />
          ))}
        </div>
      ) : null}
      {view.sums.length > 0 ? <div class="dsum">{view.sums.map((s) => <div key={s}>{s}</div>)}</div> : null}
      {view.warnings.map((w) => <InfoNote key={w} tone="warn">{w}</InfoNote>)}
      {draft.error ? <InfoNote tone="err">{draft.error} Nothing was saved.</InfoNote> : shownProblem ? <div class="small bad">{shownProblem}</div> : null}
      {note && !draft.error && view.needsAnyway === false ? <div class="small bad">{note}</div> : null}
      <div class="row" style="gap:8px">
        <button type="button" class={`btn small ${view.needsAnyway ? 'danger-fill' : ''}`} style="flex:1.3" disabled={!view.canApprove} onClick={approve}>
          {view.needsAnyway ? 'Add anyway' : 'Approve'}
        </button>
        <OutlineButton small text="Edit" disabled={!canEdit} onClick={edit} />
        <LinkButton text="Deny" onClick={() => app.chat.denyDraft(draft.id)} />
      </div>
      <div class="tiny muted">{view.choice ? 'Choose one to continue. ' : ''}Nothing is saved until you tap {view.needsAnyway ? 'Add anyway' : 'Approve'}.</div>
    </div>
  );
}
