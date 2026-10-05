import type { Ranked } from "./types.js";

/**
 * Orders entries by score (higher is better). Entries without a score are unranked (rank null) and listed after the ranked
 * ones. Ties are broken by id so the output is fully deterministic.
 */
export function order<T extends { id: string; score: number | null }>(rows: T[]): (T & { rank: number | null })[] {
  const ranked = rows.filter((r) => r.score !== null).sort((a, b) => (b.score as number) - (a.score as number) || (a.id < b.id ? -1 : 1));
  const unranked = rows.filter((r) => r.score === null).sort((a, b) => (a.id < b.id ? -1 : 1));
  return [...ranked.map((r, i) => ({ ...r, rank: i + 1 })), ...unranked.map((r) => ({ ...r, rank: null }))];
}

export type { Ranked };
