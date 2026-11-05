import { useState } from 'preact/hooks';
import { fmtDate, rupees, signedRupees, trekSummary } from '../../core/fmt';
import { partySize, trekTiming, type Booking, type PaymentSummary } from '../../core/models';
import { Card, Chip, Confirm, LinkButton, OutlineButton, Page, PrimaryButton, SectionLabel } from '../kit';
import { useApp, useStore } from '../hooks';
import { nav, to } from '../router';
import { useBy } from '../account/shared';
import { canEditBooking } from '../../core/roles';
import { EntryRow, Figure } from './shared';

function paymentLine(pay: PaymentSummary): string {
  const due = pay.due;
  if (due !== undefined && pay.received >= due) return `${rupees(pay.received)} received`;
  if (due !== undefined) return `${rupees(pay.received)} of ${rupees(due)} · ${rupees(due - pay.received)} due`;
  if (pay.received > 0) return `${rupees(pay.received)} received · no price set`;
  return 'No price set on this trek';
}

function BookingCard(p: { b: Booking; pay: PaymentSummary; onPay: () => void; onCancel: () => void; canCancel: boolean }) {
  const { b, pay } = p;
  const by = useBy();
  const added = by.created(b);
  const changed = by.changed(b);
  const meta = [`${partySize(b)} traveller${partySize(b) === 1 ? '' : 's'}`];
  if (b.phone !== '') meta.push(b.phone);
  meta.push(fmtDate(b.createdAt));
  return (
    <Card>
      <div class="stack">
        <div class="bold break" style="font-size:16px">{b.travellers.join(', ')}</div>
        <div class="small muted break">{meta.join(' · ')}</div>
        <div class="row wrap">
          {pay.status === 'Paid' ? <Chip text="PAID" /> : pay.status === 'Part paid' ? <Chip text="PART PAID" tone="amber" /> : <Chip text="PENDING" tone="neutral" />}
          <span class="small muted">{paymentLine(pay)}</span>
        </div>
        {added ? <div class="by">Added by {added}{changed && changed !== added ? ` · last changed by ${changed}` : ''}</div> : null}
        <div class="row">
          <LinkButton text="Record payment" onClick={p.onPay} />
          <span class="spacer" />
          {p.canCancel ? <LinkButton text="Cancel booking" danger onClick={p.onCancel} /> : null}
        </div>
      </div>
    </Card>
  );
}

export function TrekDetailScreen({ id }: { id: string }) {
  const app = useApp();
  useStore(app.treks, app.bookings, app.ledger, app.account);
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const trek = app.treks.trek(id);

  if (!trek) return <Page title="Trek"><div class="muted">This trek no longer exists.</div></Page>;

  const list = app.bookings.bookingsFor(trek.id);
  const taken = list.reduce((s, b) => s + partySize(b), 0);
  const tripEntries = app.ledger.entriesForTrek(trek.id);
  const received = app.ledger.receivedForTrek(trek.id);
  const paidOut = app.ledger.paidOutForTrek(trek.id);
  const net = received - paidOut;
  const scope = { type: 'trek' as const, id: trek.id };

  return (
    <Page
      title={trek.name || 'Trek'}
      trailing={app.can('editTreks') ? <LinkButton text="Edit" onClick={() => nav.go(to.editTrek(trek.id))} /> : undefined}
      footer={<PrimaryButton text="+  Add booking" onClick={() => nav.go(to.addBooking(trek.id))} disabled={trekTiming(trek) === 'past'} />}
    >
      <Card>
        <div class="stack-lg">
          <div class="small muted">{trekSummary(trek) + (trek.pricePerPerson !== undefined ? ` · ${rupees(trek.pricePerPerson)} per person` : '')}</div>
          <div class="row" style="align-items:flex-end">
            <div class="grow">
              <SectionLabel>SEATS LEFT</SectionLabel>
              <div class="bold" style={{ fontSize: trek.seatsLeft === undefined ? '20px' : '32px' }}>{trek.seatsLeft === undefined ? 'Not tracked' : trek.seatsLeft}</div>
            </div>
            <div class="small muted right">{taken} seat{taken === 1 ? '' : 's'} taken<br />by bookings below</div>
          </div>
          {trek.seatsLeft !== undefined && app.can('editTreks') ? (
            <>
              <hr class="line" />
              <div class="row">
                <div class="grow small muted">Correct the count by hand</div>
                <div class="stepper">
                  <button type="button" aria-label="One fewer seat" disabled={trek.seatsLeft <= 0} onClick={() => app.treks.adjustCapacity(trek.id, -1)}>−</button>
                  <button type="button" aria-label="One more seat" onClick={() => app.treks.adjustCapacity(trek.id, 1)}>+</button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </Card>

      {app.can('seeMoneyOut') ? <Card>
        <div class="stack-lg">
          <SectionLabel>TRIP FINANCE</SectionLabel>
          <div class="figures">
            <Figure title="Received" value={rupees(received)} color="var(--pine)" />
            <Figure title="Paid out" value={rupees(paidOut)} color="var(--rust)" />
            <Figure title="Net" value={signedRupees(net)} color={net < 0 ? 'var(--rust)' : 'var(--ink)'} />
          </div>
          <div class="row">
            <div class="grow"><OutlineButton block text="↙  Money in" onClick={() => nav.go(to.entry({ kind: 'in', trek: trek.id }))} /></div>
            <div class="grow"><OutlineButton block danger text="↗  Money out" onClick={() => nav.go(to.entry({ kind: 'out', trek: trek.id }))} /></div>
          </div>
          {tripEntries.length === 0 ? <div class="small muted">No money recorded for this trip yet.</div> : null}
          <div class="stack">
            {tripEntries.map((e) => <EntryRow key={e.id} entry={e} scope={scope} onClick={() => nav.go(to.entry({ entry: e.id }))} />)}
          </div>
        </div>
      </Card> : null}

      <SectionLabel>{`BOOKINGS · ${list.length}`}</SectionLabel>
      {list.length === 0 ? <div class="muted" style="font-size:14px">No bookings yet. Tap Add booking when a client confirms.</div> : null}
      {list.map((b) => (
        <BookingCard key={b.id} b={b} pay={app.ledger.paymentSummary(b, trek)}
          onPay={() => nav.go(to.entry({ kind: 'in', trek: trek.id, booking: b.id }))} onCancel={() => setCancelling(b)}
          canCancel={app.can('cancelBooking') && canEditBooking(app.account.role, app.account.myId, b)} />
      ))}

      {cancelling ? (
        <Confirm title="Cancel this booking?" message="Payments already recorded stay in Money. Record a refund there if you pay money back."
          confirmLabel="Cancel booking and return seats" cancelLabel="Keep booking" danger
          onConfirm={() => app.bookings.cancel(cancelling.id, app.treks)} onDismiss={() => setCancelling(null)} />
      ) : null}
    </Page>
  );
}
