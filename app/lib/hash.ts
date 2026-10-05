import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { CHAIN_ID, type DeploymentName } from "./config";

export type Plain = { perpId: number; direction: 1 | 2; tpBps: number; slBps: number; horizonSecs: number; salt: Hex };

export function deploymentOf(v: string | null): DeploymentName {
  return v === "staging" ? "staging" : "production";
}

/** keccak256(abi.encode(chainid, registry, curator, perpId, direction, tp, sl, horizonSecs, salt)), same as CallRegistry.hashCall */
export function hashPlain(registry: Address, curator: Address, p: Plain): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint8" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [BigInt(CHAIN_ID), registry, curator, BigInt(p.perpId), p.direction, p.tpBps, p.slBps, p.horizonSecs, p.salt],
    ),
  );
}
