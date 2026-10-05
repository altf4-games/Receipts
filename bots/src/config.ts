import type { Address } from "viem";

export interface Deployment {
  chainId: number;
  callRegistry: Address;
  curatorRegistry: Address;
  settlerV1: Address;
  /** present once Phase 4 contracts are deployed; the keeper uses them only while the registry's settler is `settlerV2` */
  settlerV2?: Address;
  priceTape?: Address;
  disputeWindow?: number;
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

/**
 * Public wallet addresses, fixed so an idle tick never has to derive them from private keys (creating a viem account costs ~11 ms
 * of CPU on a cold isolate, which matters on Cloudflare). `getSigner()` asserts the key really maps to this address.
 */
export const BOT_ADDRESSES: Record<string, Address> = {
  BOT_MOMENTUM: "0x64DB6511c52E7fbE338e3c9a2c1a4F0Bb381a8Ff",
  BOT_FUNDING: "0x48df90567c9db735F1015900405Ca856583f36D0",
  BOT_COINFLIP: "0x640A5b2238b4DeF4c5b9f3BF1193C99666608251",
  BOT_CONTRARIAN: "0x1984aAA5FC0914FD7Bc589140E4EE3b4Ed6714e5",
};
export const KEEPER_ADDRESS: Address = "0xEf77a024c296C6539436f699Aa16140047580D8e";

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
