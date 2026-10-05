/**
 * Inputs and outputs of every ranker. A ranker is a PURE function over public data (what the indexer serves): no clock,
 * no randomness, no network. Same input, same ranking, so anyone can rerun a ranker registered on chain at a git commit.
 */
export type CallStatus = "SEALED" | "REVEALED" | "SETTLED" | "EXPIRED" | "INVALID";

export interface CallRow {
  callId: number;
  perpId: number;
  status: CallStatus;
  /** basis points; set when the call is closed. An unrevealed or invalid call carries the -3000 penalty. */
  scoreBps: number | null;
}

export interface CuratorInput {
  id: string;
  handle: string;
  isBot: boolean;
  calls: CallRow[];
}

export interface Ranked {
  id: string;
  handle: string;
  isBot: boolean;
  /** 1 = best; null when the curator does not meet the ranker's minimum number of closed calls */
  rank: number | null;
  score: number | null;
  /** closed calls counted (settled + expired + invalid) */
  n: number;
  detail: Record<string, number>;
}

export interface Ranker {
  /** stable slug, also the registered name */
  name: string;
  description: string;
  minCalls: number;
  rank(curators: CuratorInput[]): Ranked[];
}

export const CLOSED: ReadonlySet<CallStatus> = new Set(["SETTLED", "EXPIRED", "INVALID"]);

export function closedScores(c: CuratorInput): number[] {
  const out: number[] = [];
  for (const x of c.calls) if (CLOSED.has(x.status) && x.scoreBps !== null) out.push(x.scoreBps);
  return out;
}
