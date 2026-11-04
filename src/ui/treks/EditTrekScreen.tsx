import { useState } from 'preact/hooks';
import { DIFFICULTIES, makeTrek, type Difficulty, type Trek } from '../../core/models';
import { startOfDay, toInstant, type Instant } from '../../core/ids';
import { AlertBox, Card, DateField, Field, FieldLabel, FormPage, LinkButton, Segmented, SwitchRow, Confirm } from '../kit';
import { useApp } from '../hooks';
import { nav } from '../router';
import { optionalInt } from './shared';

/** Drops fields that are undefined so an empty box leaves nothing in the saved record. */
function tidy<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function EditTrekScreenForm({ id }: { id?: string }) {
  const app = useApp();
  const [original] = useState<Trek>(() => (id ? app.treks.trek(id) : undefined) ?? makeTrek());
  const isNew = !id || app.treks.trek(id) === undefined;
  const [name, setName] = useState(original.name);
  const [region, setRegion] = useState(original.region);
  const [days, setDays] = useState(String(original.durationDays));
  const [altitude, setAltitude] = useState(original.maxAltitudeFt?.toString() ?? '');
  const [price, setPrice] = useState(original.pricePerPerson?.toString() ?? '');
  const [seats, setSeats] = useState(original.seatsLeft?.toString() ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>(original.difficulty);
  const [hasDate, setHasDate] = useState(original.startDate !== undefined);
  const [date, setDate] = useState<Instant | undefined>(original.startDate ?? toInstant(startOfDay(new Date())));
  const [highlights, setHighlights] = useState(original.highlights);
  const [notes, setNotes] = useState(original.notes);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    const trimmed = name.trim();
    if (trimmed === '') return setError('Give the trek a name.');
    const d = /^[0-9]+$/.test(days.trim()) ? Number(days.trim()) : NaN;
    if (!(d >= 1)) return setError('Days must be a number, 1 or more.');
    const alt = optionalInt(altitude);
    if (alt === null) return setError('Altitude must be a number.');
    const pr = optionalInt(price);
    if (pr === null) return setError('Price must be a number.');
    const st = optionalInt(seats);
    if (st === null) return setError('Seats left must be a number.');
    if (hasDate && date === undefined) return setError('Choose the start date.');
    app.treks.upsert(tidy({
      ...original, name: trimmed, region: region.trim(), durationDays: d, difficulty, maxAltitudeFt: alt, pricePerPerson: pr,
      startDate: hasDate && date ? toInstant(startOfDay(date)) : undefined,
      seatsLeft: hasDate ? st : undefined,
      seatCapacity: hasDate && st !== undefined ? st + app.bookings.activeSeats(original.id) : undefined,
      highlights: highlights.trim(), notes: notes.trim(),
    }));
    nav.back();
  }

  return (
    <FormPage title={isNew ? 'Add trek' : 'Edit trek'} onSave={save}>
      <Field label="Trek name" value={name} onChange={setName} words />
      <Field label="Region" value={region} onChange={setRegion} words />
      <div class="two">
        <Field label="Days" value={days} onChange={setDays} numeric />
        <Field label="Max altitude (ft)" value={altitude} onChange={setAltitude} numeric />
      </div>
      <div class="stack" style="gap:6px">
        <FieldLabel>Difficulty</FieldLabel>
        <Segmented options={DIFFICULTIES.map((x) => ({ value: x, label: x }))} selected={difficulty} onSelect={setDifficulty} />
      </div>
      <Card>
        <div class="stack">
          <SwitchRow title="Fixed start date" subtitle="Off = available on request. Past dates move to Past." checked={hasDate} onChange={setHasDate} />
          {hasDate ? <DateField label="Start date" value={date} onChange={setDate} /> : null}
        </div>
      </Card>
      <div class="two">
        <Field label="Price per person (₹)" value={price} onChange={setPrice} numeric />
        <Field label="Seats left" value={seats} onChange={setSeats} numeric disabled={!hasDate} placeholder={hasDate ? 'Seats' : 'Needs a date'} />
      </div>
      <Field label="Highlights" value={highlights} onChange={setHighlights} multiline rows={2} />
      <Field label="Notes for the assistant" value={notes} onChange={setNotes} multiline rows={3}
        placeholder="Inclusions, pickup point, who it suits, things to confirm…" />
      {!isNew ? <LinkButton text="Delete trek" danger onClick={() => setConfirmDelete(true)} /> : null}

      {confirmDelete ? (
        <Confirm title="Delete this trek and its bookings?" message="Money already recorded stays in the ledger." confirmLabel="Delete" danger
          onConfirm={() => { app.bookings.removeBookingsForTrek(original.id); app.treks.delete([original.id]); nav.backTo('/treks'); }}
          onDismiss={() => setConfirmDelete(false)} />
      ) : null}
      {error ? <AlertBox title="Can't save" text={error} onDismiss={() => setError(null)} /> : null}
    </FormPage>
  );
}

/** Keyed by id, so opening a different record starts the form afresh. */
export function EditTrekScreen({ id }: { id?: string }) {
  return <EditTrekScreenForm key={id ?? 'new'} id={id} />;
}
