import { rupees, trekSummary } from '../../core/fmt';
import { trekTiming, type Trek } from '../../core/models';
import { Card, Chip, Page, SectionLabel, LinkButton } from '../kit';
import { useApp, useStore } from '../hooks';
import { nav, to } from '../router';
import './treks.css';

const EmptyRow = (p: { text: string }) => <div class="small muted" style="padding:4px 0">{p.text}</div>;

type Footer = 'seats' | 'again' | 'none';

function TrekCard({ t, footer }: { t: Trek; footer: Footer }) {
  const timing = trekTiming(t);
  return (
    <Card class="flush">
      <div class="card-head" role="button" onClick={() => nav.go(to.trek(t.id))}>
        <div class="row">
          <div class="grow bold break" style={{ fontSize: '16px', color: timing === 'past' ? 'var(--label)' : 'var(--ink)' }}>{t.name || 'Untitled trek'}</div>
          {timing === 'upcoming' ? (t.seatsLeft === 0 ? <Chip text="SOLD OUT" tone="rust" /> : <Chip text="UPCOMING" />) : null}
          {timing === 'undated' ? <Chip text="ADD DATES" tone="amber" /> : null}
          {timing === 'past' ? <Chip text="PAST" tone="neutral" /> : null}
        </div>
        <div class="small muted">{trekSummary(t)}</div>
        {t.pricePerPerson !== undefined && timing !== 'undated' ? <div style="font-size:14px;font-weight:500">{rupees(t.pricePerPerson)} per person</div> : null}
      </div>
      {footer !== 'none' ? (
        <div class="card-foot">
          <div class="grow small muted">
            {footer === 'seats' ? (t.seatsLeft !== undefined ? (t.seatsLeft === 0 ? 'Sold out' : `Seats left ${t.seatsLeft}`) : 'Seats not tracked') : 'Running it again?'}
          </div>
          <LinkButton text="Duplicate" onClick={() => nav.go(to.duplicateTrek(t.id))} />
        </div>
      ) : null}
    </Card>
  );
}

export function TreksScreen() {
  const app = useApp();
  useStore(app.treks);
  const upcoming = app.treks.upcoming();
  const undated = app.treks.undated();
  const past = app.treks.past();
  return (
    <Page tab title="Treks" trailing={<button class="iconbtn" type="button" aria-label="Add trek" onClick={() => nav.go(to.editTrek())}>+</button>}>
      <SectionLabel>{`UPCOMING · ${upcoming.length}`}</SectionLabel>
      {upcoming.length === 0 ? <EmptyRow text="Nothing scheduled. Tap + to add the next batch." /> : null}
      {upcoming.map((t) => <TrekCard key={t.id} t={t} footer="seats" />)}

      <SectionLabel>{`ON REQUEST · NO FIXED DATE · ${undated.length}`}</SectionLabel>
      {undated.length === 0 ? <EmptyRow text="None." /> : null}
      {undated.map((t) => <TrekCard key={t.id} t={t} footer="none" />)}

      <SectionLabel>{`PAST · ${past.length}`}</SectionLabel>
      {past.length === 0 ? <EmptyRow text="None yet. Past treks stay here so the assistant knows what you can run." /> : null}
      {past.map((t) => <TrekCard key={t.id} t={t} footer="again" />)}
    </Page>
  );
}

