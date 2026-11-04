import { useEffect, useState } from 'preact/hooks';
import { fmtDate, rupees } from '../../core/fmt';
import { PAYMENT_MODES, trekEndDate, type PaymentMode } from '../../core/models';
import { MAX_PARTY } from '../../core/stores';
import { AlertBox, Field, FormPage, InfoNote, Page, PickerRow } from '../kit';
import { useApp, useStore } from '../hooks';
import { nav } from '../router';
import { Stepper } from './shared';

function ConfirmBookingScreenForm({ trekID }: { trekID: string }) {
  const app = useApp();
  useStore(app.treks);
  const trek = app.treks.trek(trekID);
  const [party, setParty] = useState(2);
  const [names, setNames] = useState<string[]>(() => Array(MAX_PARTY).fill(''));
  const [phone, setPhone] = useState('');
  const [amountText, setAmountText] = useState('');
  const [mode, setMode] = useState<PaymentMode>('UPI');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!trek) nav.back(); }, [trek]);
  if (!trek) return <Page title="Add booking"><div class="muted">This trek no longer exists.</div></Page>;

  const seats = trek.seatsLeft;
  const overBooked = seats !== undefined && party > seats;

  function confirm() {
    const t = amountText.trim();
    let amount: number | undefined;
    if (t !== '') {
      if (!/^[0-9]+$/.test(t)) return setError('Amount received must be a number.');
      amount = Number(t);
    }
    try {
      app.bookings.confirm({ trekID: trek!.id, travellers: names.slice(0, party), phone, amountReceived: amount, mode, trekStore: app.treks, ledger: app.ledger });
      nav.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The booking could not be saved.');
    }
  }

  const when = trek.startDate ? ` · ${fmtDate(trek.startDate)} to ${fmtDate(trekEndDate(trek) ?? new Date(trek.startDate))}` : '';

  return (
    <FormPage title="Add booking" saveLabel="Confirm" onSave={confirm}>
      <div class="muted" style="font-size:14px">{trek.name + when}</div>

      <div class="group" style="flex-direction:row;align-items:center;padding:6px 14px">
        <div class="grow bold" style="font-size:15px">Travellers</div>
        <Stepper value={party} min={1} max={MAX_PARTY} onChange={setParty} />
      </div>
      {Array.from({ length: party }, (_, i) => (
        <Field key={i} label={i === 0 ? 'Traveller 1 · booking contact' : `Traveller ${i + 1}`} value={names[i]} placeholder="Full name" words
          onChange={(v) => setNames((cur) => cur.map((x, j) => (j === i ? v : x)))} />
      ))}
      <div class="two">
        <Field label="Contact number" value={phone} onChange={setPhone} placeholder="Phone" phone />
        <Field label="Received now (₹)" value={amountText} onChange={setAmountText} placeholder="optional" numeric />
      </div>
      {amountText.trim() !== '' ? (
        <PickerRow title="Paid by" value={mode} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} onSelect={setMode} />
      ) : null}
      {trek.pricePerPerson !== undefined ? (
        <InfoNote>{`Total due: ${rupees(trek.pricePerPerson * party)} for ${party}. Payment status follows what is recorded in Money.`}</InfoNote>
      ) : null}

      {seats !== undefined ? (
        <div class={`seatbox ${overBooked ? 'over' : ''}`}>
          <div class="grow" style="font-size:14px;font-weight:500">Seats left</div>
          {overBooked
            ? <div class="bold bad" style="font-size:15px">{`Only ${seats} left`}</div>
            : <div class="bold" style="font-size:18px">{`${seats}  →  ${seats - party}`}</div>}
        </div>
      ) : <InfoNote>Seats aren't tracked for this trek, so the count won't change.</InfoNote>}

      <div class="tiny muted center">Names and phone numbers stay on this device. Only the seat count reaches the assistant.</div>
      {error ? <AlertBox title="Can't add booking" text={error} onDismiss={() => setError(null)} /> : null}
    </FormPage>
  );
}

/** Keyed by id, so opening a different record starts the form afresh. */
export function ConfirmBookingScreen({ trekID }: { trekID: string }) {
  return <ConfirmBookingScreenForm key={trekID} trekID={trekID} />;
}
