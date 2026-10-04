import type { Address } from "viem";

export interface Deployment {
  chainId: number;
  callRegistry: Address;
  curatorRegistry: Address;
  settlerV1: Address;
  exchange: Address;
  bondToken: Address;
  minBond: number;
  minHorizon: number;
  maxOracleAge: number;
}

/** Perpl TESTNET perpIds (they differ from mainnet). */
export const MARKETS = { BTC: 16n, ETH: 32n, SOL: 48n, MON: 64n, ZEC: 256n } as const;

export type StrategyId = "momentum" | "funding" | "coinflip" | "contrarian";

export interface BotSpec {
  /** env prefix of its wallet, e.g. BOT_MOMENTUM -> BOT_MOMENTUM_PRIVATE_KEY */
  envPrefix: string;
  /** onchain handle; MUST start with "bot:" (CuratorRegistry enforces it) */
  handle: string;
  strategy: StrategyId;
  markets: bigint[];
  /** base horizon in seconds; a small time-derived jitter is added (see params.jitteredHorizon) */
  horizonBase: number;
  metadataURI: string;
}

export const BOTS: BotSpec[] = [
  { envPrefix: "BOT_MOMENTUM", handle: "bot:momentum", strategy: "momentum", markets: [MARKETS.BTC, MARKETS.ETH, MARKETS.SOL], horizonBase: 3600, metadataURI: "Receipts bot: EMA(6/18) trend follower on 5m Perpl candles. Not advice." },
  { envPrefix: "BOT_FUNDING", handle: "bot:funding-fade", strategy: "funding", markets: [MARKETS.BTC, MARKETS.ETH, MARKETS.SOL], horizonBase: 14400, metadataURI: "Receipts bot: fades the sign of Perpl funding. Not advice." },
  { envPrefix: "BOT_COINFLIP", handle: "bot:coinflip", strategy: "coinflip", markets: [MARKETS.BTC, MARKETS.ETH, MARKETS.SOL], horizonBase: 3600, metadataURI: "Receipts bot: random direction. The no-skill baseline." },
  { envPrefix: "BOT_CONTRARIAN", handle: "bot:contrarian", strategy: "contrarian", markets: [MARKETS.BTC, MARKETS.ETH, MARKETS.SOL], horizonBase: 3600, metadataURI: "Receipts bot: inverse of the momentum signal. Not advice." },
];

export interface Cadence {
  /** every (bot, market) pair gets one commit window per period */
  periodSecs: number;
  /** length of that window; ticks inside it may commit if the slot is free */
  windowSecs: number;
}
export const DEFAULT_CADENCE: Cadence = { periodSecs: 8 * 3600, windowSecs: 20 * 60 };

/** Below these balances the bot logs loudly and stops spending. */
export const MIN_COMMIT_BALANCE_WEI = 150_000_000_000_000_000n; // 0.15 MON
export const MIN_KEEPER_BALANCE_WEI = 100_000_000_000_000_000n; // 0.10 MON
