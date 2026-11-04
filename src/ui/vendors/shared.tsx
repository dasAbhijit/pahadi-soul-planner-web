import { Chip } from '../kit';
import '../treks/treks.css';

/** A row of grey tag chips. */
export function TagChips({ tags }: { tags: string[] }) {
  return <div class="chips">{tags.map((t) => <Chip key={t} text={t.toUpperCase()} tone="neutral" />)}</div>;
}
