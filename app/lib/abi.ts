export const callRegistryAbi = [
  { type: "function", name: "nextCallId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getCall", stateMutability: "view", inputs: [{ name: "callId", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "curator", type: "address" }, { name: "perpId", type: "uint32" }, { name: "status", type: "uint8" },
        { name: "priceDecimals", type: "uint8" }, { name: "direction", type: "uint8" }, { name: "tpBps", type: "uint16" },
        { name: "slBps", type: "uint16" }, { name: "flags", type: "uint16" }, { name: "scoreBps", type: "int32" },
        { name: "horizonSecs", type: "uint32" }, { name: "commitBlock", type: "uint64" }, { name: "commitTime", type: "uint64" },
        { name: "horizonEnd", type: "uint64" }, { name: "entryOracleTs", type: "uint64" }, { name: "revealBlock", type: "uint64" },
        { name: "closeBlock", type: "uint64" }, { name: "entryPNS", type: "uint128" }, { name: "hash", type: "bytes32" },
      ],
    }],
  },
] as const;

export const curatorRegistryAbi = [
  {
    type: "function", name: "getCurator", stateMutability: "view", inputs: [{ name: "curator", type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "handle", type: "string" }, { name: "metadataURI", type: "string" }, { name: "isBot", type: "bool" },
        { name: "registered", type: "bool" }, { name: "bond", type: "uint128" }, { name: "withdrawAfter", type: "uint64" },
      ],
    }],
  },
] as const;

export const subscriptionsAbi = [
  { type: "function", name: "isActive", stateMutability: "view", inputs: [{ name: "subscriber", type: "address" }, { name: "curator", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ratePerSec", stateMutability: "view", inputs: [{ name: "curator", type: "address" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "activeUntil", stateMutability: "view", inputs: [{ name: "subscriber", type: "address" }, { name: "curator", type: "address" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "subscribe", stateMutability: "nonpayable", inputs: [{ name: "curator", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "curator", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const priceTapeAbi = [
  { type: "function", name: "sampleCount", stateMutability: "view", inputs: [{ name: "perpId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "firstIndexAtOrAfter", stateMutability: "view", inputs: [{ name: "perpId", type: "uint256" }, { name: "ts", type: "uint64" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "sampleAt", stateMutability: "view", inputs: [{ name: "perpId", type: "uint256" }, { name: "index", type: "uint256" }],
    outputs: [{ type: "tuple", components: [{ name: "ts", type: "uint64" }, { name: "blockNumber", type: "uint64" }, { name: "price", type: "uint128" }] }],
  },
] as const;

export const settlerV2Abi = [
  {
    type: "function", name: "proposals", stateMutability: "view", inputs: [{ name: "callId", type: "uint256" }],
    outputs: [{ name: "proposedAt", type: "uint64" }, { name: "index", type: "uint32" }, { name: "scoreBps", type: "int32" }, { name: "touch", type: "bool" }, { name: "disputed", type: "bool" }, { name: "finalized", type: "bool" }],
  },
] as const;
