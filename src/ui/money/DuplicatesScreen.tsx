import { useMemo, useState } from 'preact/hooks';
import { useApp, useStore } from '../hooks';
import { Card, Confirm, InfoNote, LinkButton, OutlineButton, Page } from '../kit';
import { fmtDate, fmtDateTime, rupees } from '../../core/fmt';
import { duplicateGroups } from '../../core/syncmerge';
import type { LedgerEntry } from '../../core/models';
import './money.css';

/** Payments that look like the same one typed twice. Nothing is removed automatically: keep them all, or delete one. */
export function DuplicatesScreen() {
  const app = useApp();
  useStore(app.ledger, app.settings);
  const dismissed = app.settings.dismissedDuplicates;
  const groups = useMemo(() => duplicateGroups(app.ledger.entries, dismissed), [app.ledger.entries, dismissed]);
  const [pending, setPending] = useState<LedgerEntry | null>(null);

  return (
    <Page title="Possible duplicates">
      {groups.length === 0 ? (
        <div class="muted" style="font-size:15px">No possible duplicates left.</div>
      ) : (
        <InfoNote>These entries have the same type, amount, day, trip and traveller or vendor. If the same payment was typed on two phones, delete one. If they are genuinely separate, keep all.</InfoNote>
      )}
      {groups.map((g) => {
        const first = g.entries[0];
        return (
          <Card key={g.id}>
            <div class="stack-lg">
              <div class="title">{rupees(first.amount)} · {first.kind} · {fmtDate(first.date)}</div>
              <div class="small muted break">{first.shares[0]?.trekName ?? 'No trip'} · {first.vendorName ?? first.customerName ?? ''}</div>
              {g.entries.map((e) => (
                <div class="row" key={e.id}>
                  <div class="grow stack" style="gap:2px">
                    <div style="font-size:14px">Recorded {fmtDateTime(e.createdAt)} · {e.mode}</div>
                    {e.note !== '' ? <div class="small muted clamp2 break">{e.note}</div> : null}
                  </div>
                  <LinkButton text="Delete" danger onClick={() => setPending(e)} />
                </div>
              ))}
              <OutlineButton block text={`Keep all ${g.entries.length}`} onClick={() => app.settings.dismissDuplicates(g.id)} />
            </div>
          </Card>
        );
      })}
      {pending ? (
        <Confirm
          title="Delete this entry?" danger confirmLabel="Delete"
          message={`${rupees(pending.amount)} recorded ${fmtDateTime(pending.createdAt)}. The fund balance changes by that amount.`}
          onConfirm={() => app.ledger.remove(pending.id)} onDismiss={() => setPending(null)}
        />
      ) : null}
    </Page>
  );
}
