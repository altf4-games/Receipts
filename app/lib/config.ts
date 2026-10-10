// Production (frozen) Monad testnet deployment. Source of truth: deployments/production.json in the repo.
export const CHAIN_ID = 10143;
export const RPC_URL = process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadvision.com";

export const ADDR = {
  curatorRegistry: "0x1e917319c379fd4e62Bf3207379E3d8bb1A468AF",
  callRegistry: "0x1E9b6c2e6484CcbeA63F4567905012a28Fa1753C",
  settlerV1: "0xF39358B88cF73a1d9158f00b9D5E39A04543E03f",
  subscriptions: "0xcbDFf5C6f618dEA573a4B0FE000AF712F85D661e",
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
} as const;

/** Perpl testnet market ids (they differ from mainnet ids). */
export const MARKETS: Record<number, string> = { 16: "BTC", 32: "ETH", 48: "SOL", 64: "MON", 256: "ZEC" };

/** Staging (short horizons) exists only so the live tests never touch production history. Keys are namespaced per deployment. */
export const DEPLOYMENTS = {
  production: ADDR,
  staging: {
    curatorRegistry: "0x9F11f5b79e5e91Fb7F73DD911F31D323d545ba63",
    callRegistry: "0xda5693e16102f9fAfedE5e8A1dd3595D72665BeA",
    settlerV1: "0x585C1E9358e9ce0c91676708d6989927192cd242",
    subscriptions: "0x41BB16670787c9036CC10D008424a4ebDf1d76E4",
    ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  },
} as const;
export type DeploymentName = keyof typeof DEPLOYMENTS;

/** First block of each Subscriptions deployment: where the event scanner starts. */
export const SUBS_DEPLOY_BLOCK: Record<DeploymentName, number> = { production: 68317022, staging: 68316433 };

/** Agora testnet AUSD faucet: requestFunds(address) sends 10,000 AUSD, one request per 60 s. Gas is paid in MON (faucet.monad.xyz). */
export const AUSD_FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as const;
export const MON_FAUCET_URL = "https://faucet.monad.xyz";

/** Public Envio Cloud endpoint (HyperIndex, Monad testnet + mainnet). Everything in it is public on-chain data. */
export const ENVIO_GRAPHQL = process.env.ENVIO_GRAPHQL ?? "https://indexer.dev.hyperindex.xyz/851d538/v1/graphql";
export const RANKER_REGISTRY = "0xc1936e5Ce100B7801fffBe99339F1757A3049581" as const;

/** Phase 4 stack (production). Receipt pages read the tape and proposals from here; staging (v1) has none. */
export const TAPE = {
  priceTape: "0xC028FCBE295bFA67bD1aA17e1f467214cE0Bf814",
  settlerV2: "0xBdCF5A34a13617f62FFB9d3155dF3fA2939e73Dc",
  disputeWindow: 900,
} as const;
