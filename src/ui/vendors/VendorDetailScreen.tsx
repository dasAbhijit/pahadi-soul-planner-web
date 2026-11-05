import { rupees } from '../../core/fmt';
import { vendorRateText } from '../../core/models';
import type { TripLine } from '../../core/models';
import { Card, Chip, LinkButton, Page, PrimaryButton, SectionLabel } from '../kit';
import { useApp, useStore } from '../hooks';
import { nav, to } from '../router';
import { EntryRow, Figure } from '../treks/shared';
import { TagChips } from './shared';

function tripText(l: TripLine): string {
  if (l.agreed === 0) return `${rupees(l.paid)} paid · no agreed amount`;
  if (l.owed === 0) return `${rupees(l.paid)} of ${rupees(l.agreed)} · settled`;
  return `${rupees(l.paid)} of ${rupees(l.agreed)} · ${rupees(l.owed)} owed`;
}

export function VendorDetailScreen({ id }: { id: string }) {
  const app = useApp();
  useStore(app.vendors, app.ledger, app.account);
  const v = app.vendors.vendor(id);
  const money = app.can('seeVendorRates');
  if (!v) return <Page title="Vendor"><div class="muted">This vendor no longer exists.</div></Page>;

  const st = app.ledger.statement(v);
  const payouts = app.ledger.entriesForVendor(v.id);
  const contact = [v.contactName, v.phone].filter((s) => s !== '').join(' · ');

  return (
    <Page
      title={v.name}
      trailing={app.can('editVendors') ? <LinkButton text="Edit" onClick={() => nav.go(to.editVendor(v.id))} /> : undefined}
      footer={money ? <PrimaryButton text="↗  Record payout" onClick={() => nav.go(to.entry({ kind: 'out', vendor: v.id }))} /> : undefined}
    >
      <Card>
        <div class="stack">
          <div class="row">
            <Chip text={v.service.toUpperCase()} />
            <span class="spacer" />
            {money ? <span class="bold" style="font-size:15px">{vendorRateText(v) ?? 'Rate not set'}</span> : null}
          </div>
          {contact !== '' ? <div class="muted break" style="font-size:14px">{contact}</div> : null}
          {v.tags.length > 0 ? <TagChips tags={v.tags} /> : null}
          {v.notes !== '' ? <div class="pre break" style="font-size:14px">{v.notes}</div> : null}
          <div class="tiny muted">The assistant sees the name, service, rate, tags and notes. Phone numbers and payments stay on this device.</div>
        </div>
      </Card>

      {money ? <Card>
        <div class="stack-lg">
          <SectionLabel>VENDOR BALANCE</SectionLabel>
          <div class="figures">
            <Figure title="Paid" value={rupees(st.totalPaid)} color="var(--rust)" />
            <Figure title="Agreed" value={rupees(st.totalAgreed)} />
            <Figure title="Owed" value={rupees(st.owed)} color={st.owed > 0 ? 'var(--amber-fg)' : 'var(--pine)'} />
          </div>
          {st.trips.length > 0 ? (
            <>
              <hr class="line" />
              {st.trips.map((line) => (
                <div class="row top" key={line.trekID}>
                  <div class="grow break" style="font-size:14px;font-weight:500">{line.trekName}</div>
                  <div class="small muted right">{tripText(line)}</div>
                </div>
              ))}
            </>
          ) : null}
          {st.unassignedPaid > 0 ? (
            <div class="row">
              <div class="grow" style="font-size:14px;font-weight:500">Not tied to a trip</div>
              <div class="small muted">{rupees(st.unassignedPaid)} paid</div>
            </div>
          ) : null}
        </div>
      </Card> : null}

      {money ? <SectionLabel>{`PAYOUTS · ${payouts.length}`}</SectionLabel> : null}
      {money && payouts.length === 0 ? <div class="muted" style="font-size:14px">Nothing paid to this vendor yet.</div> : null}
      {money ? payouts.map((e) => <EntryRow key={e.id} entry={e} onClick={() => nav.go(to.entry({ entry: e.id }))} />) : null}
    </Page>
  );
}
