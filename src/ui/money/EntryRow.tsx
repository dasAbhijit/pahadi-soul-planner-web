import { Card } from '../kit';
import { amountIn, type LedgerEntry, type LedgerScope } from '../../core/models';
import { fmtDate, rupees } from '../../core/fmt';
import './money.css';

/** One transaction in a list. Looking at a single trip shows that trip's share of the amount. */
export function EntryRow(p: { entry: LedgerEntry; scope?: LedgerScope; onClick: () => void }) {
  const e = p.entry;
  const scope: LedgerScope = p.scope ?? { type: 'all' };
  const isIn = e.kind === 'Money in';
  const title = (e.vendorName || e.customerName || e.party || e.kind) as string;
  const parts: string[] = [fmtDate(e.date), e.mode];
  if (e.shares.length === 0) parts.push('No trip');
  else if (e.shares.length === 1) parts.push(e.shares[0].trekName);
  else parts.push(`${e.shares.length} trips`);
  if (e.customerName && e.party !== '' && e.party !== e.customerName) parts.unshift(e.party);
  if (e.vendorName && e.vendorName !== e.party) parts.unshift(e.vendorName);
  const shown = amountIn(e, scope);

  return (
    <Card onClick={p.onClick}>
      <div class="entry-row">
        <div class={`entry-ico ${isIn ? 'in' : 'out'}`} aria-hidden="true">{isIn ? '↙' : '↗'}</div>
        <div class="grow stack" style="gap:3px">
          <div class="bold break" style="font-size:15px">{title}</div>
          <div class="small muted break">{parts.join(' · ')}</div>
          {e.note !== '' ? <div class="small muted clamp2 break">{e.note}</div> : null}
        </div>
        <div class="right">
          <div class={`bold ${isIn ? '' : 'bad'}`} style={isIn ? 'color:var(--pine)' : ''}>{(isIn ? '+' : '−') + rupees(shown)}</div>
          {scope.type === 'trek' && shown !== e.amount ? <div class="tiny muted">of {rupees(e.amount)}</div> : null}
        </div>
      </div>
    </Card>
  );
}
