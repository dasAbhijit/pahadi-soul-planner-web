import { ms, toInstant, type Id, type Instant } from './ids';
import { same } from './codec';
import type { SyncFields } from './models';

export const isDeleted = (r: SyncFields) => r.deletedAt !== undefined;

/** When this version of the record was made. Records that never had a stamp count as oldest. */
export const changedAt = (r: SyncFields): number => (r.updatedAt === undefined ? -Infinity : ms(r.updatedAt));

/** Stamps are whole seconds, so a stamp reads back from storage or the sheet exactly as it was written. */
export const SyncClock = {
  provider: (): number => Date.now(),
  now(): Instant { return toInstant(Math.floor(this.provider() / 1000) * 1000); },
};

/**
 * The signed-in person, set by the app. Stores stamp every record they make or change with this id, so the
 * app can show who recorded what. Unset when nobody is signed in (tests, or before the first sign-in).
 */
export const Actor: { id: Id | undefined } = { id: undefined };

/**
 * Stamps a record as made or changed now by the signed-in person. `old` is the stored version, if there is one:
 * an existing record keeps its author, a new one gets the signed-in person as its author.
 */
export function stampRecord<T extends SyncFields>(rec: T, old: T | undefined, now: Instant = SyncClock.now()): T {
  const out: T = { ...rec, updatedAt: now };
  delete out.deletedAt;
  const who = Actor.id;
  if (who) {
    out.updatedBy = who;
    if (old) { if (old.createdBy) out.createdBy = old.createdBy; else delete out.createdBy; }
    else if (!out.createdBy) out.createdBy = who;
  }
  return out;
}

/** How the stores keep live and deleted records side by side. */
export const SyncList = {
  split<T extends SyncFields>(all: T[]): { live: T[]; deleted: T[] } {
    return { live: all.filter((r) => !isDeleted(r)), deleted: all.filter(isDeleted) };
  },

  /** Gives every live record that has no stamp one. Returns null if nothing changed. */
  stampMissing<T extends SyncFields>(live: T[], now: Instant): T[] | null {
    if (live.every((r) => r.updatedAt !== undefined)) return null;
    return live.map((r) => (r.updatedAt === undefined ? { ...r, updatedAt: now } : r));
  },

  /** Moves the records with these ids from live to deleted. */
  remove<T extends SyncFields>(ids: Set<Id>, live: T[], deleted: T[], now: Instant): { live: T[]; deleted: T[] } {
    const keep: T[] = [];
    let gone = deleted;
    for (const r of live) {
      if (ids.has(r.id)) {
        const t = { ...r, updatedAt: now, deletedAt: now };
        if (Actor.id) t.updatedBy = Actor.id;
        gone = [...gone.filter((x) => x.id !== t.id), t];
      } else keep.push(r);
    }
    return { live: keep, deleted: gone };
  },

  /**
   * Makes `next` the live list. Records that did not change keep their stamp; changed and new ones are stamped
   * now; live records missing from `next` become deleted.
   */
  replace<T extends SyncFields>(live: T[], deleted: T[], next: T[], now: Instant): { live: T[]; deleted: T[] } {
    const oldByID = new Map<Id, T>(live.map((r) => [r.id, r]));
    const newIDs = new Set(next.map((r) => r.id));

    const outLive: T[] = [];
    for (const r0 of next) {
      const r: T = { ...r0 };
      delete r.deletedAt;
      const old = oldByID.get(r.id);
      if (old) {
        const probe: T = { ...r };
        if (old.updatedAt === undefined) delete probe.updatedAt; else probe.updatedAt = old.updatedAt;
        if (same(probe, old)) { outLive.push(old); continue; }
      }
      outLive.push(stampRecord(r, old, now));
    }

    const outDeleted = deleted.filter((r) => !newIDs.has(r.id));
    for (const old of live) {
      if (newIDs.has(old.id)) continue;
      const t = { ...old, updatedAt: now, deletedAt: now };
      if (Actor.id) t.updatedBy = Actor.id;
      outDeleted.push(t);
    }
    return { live: outLive, deleted: outDeleted };
  },
};
