import { useEffect, useState } from 'preact/hooks';
import { startOfDay, toInstant, type Instant } from '../../core/ids';
import { InfoNote, DateField, FormPage, Page } from '../kit';
import { useApp } from '../hooks';
import { nav, to } from '../router';

function DuplicateTrekScreenForm({ id }: { id: string }) {
  const app = useApp();
  const trek = app.treks.trek(id);
  const [date, setDate] = useState<Instant | undefined>(() => toInstant(startOfDay(Date.now() + 30 * 24 * 3600 * 1000)));
  useEffect(() => { if (!trek) nav.back(); }, [trek]);
  if (!trek) return <Page title="Duplicate trek"><div class="muted">This trek no longer exists.</div></Page>;

  function create() {
    if (!date) return;
    const copy = app.treks.duplicate(id, toInstant(startOfDay(date)));
    if (copy) nav.replace(to.editTrek(copy.id));
  }

  return (
    <FormPage title="Duplicate trek" saveLabel="Create copy" canSave={date !== undefined} onSave={create}>
      <div>
        <div class="bold" style="font-size:20px">Duplicate trek</div>
        <div class="muted" style="font-size:14px">{`${trek.name} · ${trek.durationDays} days · ${trek.difficulty}`}</div>
      </div>
      <DateField label="New start date" value={date} onChange={setDate} />
      <InfoNote>Price, duration, highlights and notes are copied. Seats are left blank, so you enter the real number for this batch.</InfoNote>
    </FormPage>
  );
}

/** Keyed by id, so opening a different record starts the form afresh. */
export function DuplicateTrekScreen({ id }: { id: string }) {
  return <DuplicateTrekScreenForm key={id} id={id} />;
}
