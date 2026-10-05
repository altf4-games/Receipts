import { envio } from "./envio";
import { ALL_RANKERS, type CuratorInput, type Ranked, type Ranker } from "./rankers";

export type LeaderboardData = {
  curators: CuratorInput[];
  receipts: { id: string; name: string; codeURI: string; gitCommit: string; registeredBlock: number }[];
};

/** Everything the rankers need, from the indexer: each curator with their calls and scores. */
export async function leaderboardData(): Promise<LeaderboardData> {
  const d = await envio<{
    Curator: { id: string; handle: string; isBot: boolean; calls: { callId: number; perpId: number; status: CuratorInput["calls"][number]["status"]; scoreBps: number | null }[] }[];
    Ranker: LeaderboardData["receipts"];
  }>(`{ Curator(where:{chainId:{_eq:10143}}) { id handle isBot calls { callId perpId status scoreBps } } Ranker(order_by:{id:asc}) { id name codeURI gitCommit registeredBlock } }`);
  return { curators: d.Curator.map((c) => ({ id: c.id, handle: c.handle, isBot: c.isBot, calls: c.calls })), receipts: d.Ranker };
}

export const rankerByName = (name: string | undefined): Ranker => ALL_RANKERS.find((r) => r.name === name) ?? ALL_RANKERS[0]!;
export type { Ranked };
