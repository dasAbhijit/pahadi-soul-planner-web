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
  const title = { booking: 'booking', paymentIn: 'payment received', paymentOut: 'payment out', trek: 'trek', vendor: 'vendor' }[draft.data.kind];

  if (state === 'denied') return <div class="draft closed">Denied. Nothing was saved.</div>;
  if (state === 'replaced') return <div class="draft closed">Replaced by a newer draft. Nothing was saved.</div>;
  if (state === 'applied' || state === 'saved') {
    const kind = draft.data.kind;
    const trekID = kind === 'booking' ? draft.data.trekID : undefined;
    const recordID = draft.recordIDs?.[0];
    return (
      <div class="draft done" role="status">
        {state === 'saved'
          ? <><div class="row ok bold small"><span>✓</span><span>Saved from the form</span></div><div class="small">{draft.result}</div></>
          : <div class="row ok bold small"><span>✓</span><span>{draft.result}</span></div>}
        <div class="row wrap" style="gap:16px">
          {kind === 'booking' && trekID ? <LinkButton text="Open booking" onClick={() => nav.go(to.trek(trekID))} /> : null}
          {kind === 'paymentIn' || kind === 'paymentOut' ? <LinkButton text="View in Money" onClick={() => nav.go('/money')} /> : null}
          {kind === 'trek' && recordID ? <LinkButton text="Open trek" onClick={() => nav.go(to.trek(recordID))} /> : null}
          {kind === 'vendor' && recordID ? <LinkButton text="Open vendor" onClick={() => nav.go(to.vendor(recordID))} /> : null}
        </div>
      </div>
    );
  }
  if (!view) return null;

  const approve = () => {
    const why = app.chat.approveDraft(draft.id, view.needsAnyway);
    setNote(why);
  };
  const data = draft.data;
  const edit = () => {
    switch (data.kind) {
      case 'booking': if (data.trekID) nav.go(to.addBooking(data.trekID, draft.id)); break;
      case 'paymentIn': nav.go(to.entry({ kind: 'in', trek: data.trekID, booking: data.bookingID, draft: draft.id })); break;
      case 'paymentOut': nav.go(to.entry({ kind: 'out', trek: data.trekID, vendor: data.vendorID, booking: data.bookingID, draft: draft.id })); break;
      case 'trek': nav.go(to.editTrek(undefined, draft.id)); break;
      case 'vendor': nav.go(to.editVendor(undefined, draft.id)); break;
    }
  };
  const canEdit = data.kind !== 'booking' || data.trekID !== undefined;
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
