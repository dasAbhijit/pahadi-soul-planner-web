import { amountIn, type LedgerEntry, type LedgerScope } from '../../core/models';
import { fmtDate, rupees } from '../../core/fmt';
import { useBy } from '../account/shared';
import './treks.css';

/** A small figure with a title above it, used in the finance summaries. */
export function Figure(p: { title: string; value: string; color?: string }) {
  return (
    <div class="figure">
      <div class="t">{p.title}</div>
      <div class="v" style={p.color ? { color: p.color } : undefined}>{p.value}</div>
    </div>
  );
}

/** A minus, a number and a plus. */
export function Stepper(p: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div class="stepper">
      <button type="button" aria-label="Fewer" disabled={p.value <= p.min} onClick={() => p.onChange(p.value - 1)}>−</button>
      <span class="n">{p.value}</span>
      <button type="button" aria-label="More" disabled={p.value >= p.max} onClick={() => p.onChange(p.value + 1)}>+</button>
    </div>
  );
}

/**
 * One transaction as a card row, the same as the Android EntryRow. Shown on a trek and on a vendor.
 * `scope` makes it show the trip's share when looking at one trip.
 */
export function EntryRow(p: { entry: LedgerEntry; scope?: LedgerScope; onClick: () => void }) {
  const e = p.entry;
  const by = useBy().first(e);
  const scope = p.scope ?? { type: 'all' as const };
  const isIn = e.kind === 'Money in';
  const title = (e.vendorName || undefined) ?? (e.customerName || undefined) ?? (e.party || e.kind);
  const parts: string[] = [fmtDate(e.date), e.mode];
  if (e.shares.length === 0) parts.push('No trip');
  else if (e.shares.length === 1) parts.push(e.shares[0].trekName);
  else parts.push(`${e.shares.length} trips`);
  if (e.customerName && e.party !== '' && e.party !== e.customerName) parts.unshift(e.party);
  if (e.vendorName && e.vendorName !== e.party) parts.unshift(e.vendorName);
  if (by) parts.push(by);
  const shown = amountIn(e, scope);
  return (
    <div class="card tap entry" role="button" onClick={p.onClick}>
      <div class={`dot ${isIn ? 'in' : 'out'}`} aria-hidden="true">{isIn ? '↙' : '↗'}</div>
      <div class="grow stack" style="gap:3px">
        <div class="bold break" style="font-size:15px">{title}</div>
        <div class="small muted break">{parts.join(' · ')}</div>
        {e.note ? <div class="small muted break">{e.note}</div> : null}
      </div>
      <div class="amt" style={{ color: isIn ? 'var(--pine)' : 'var(--rust)' }}>
        {(isIn ? '+' : '−') + rupees(shown)}
        {scope.type === 'trek' && shown !== e.amount ? <div class="tiny muted" style="font-weight:400">of {rupees(e.amount)}</div> : null}
      </div>
    </div>
  );
}

/** Reads an optional whole number from a text box. Returns undefined for an empty box and null for a bad one. */
export function optionalInt(text: string): number | undefined | null {
  const t = text.trim();
  if (t === '') return undefined;
  if (!/^[0-9]+$/.test(t)) return null;
  return Number(t);
}
