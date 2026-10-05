import { describe, expect, test } from "vitest";
import { findClusters, type ClusterCurator } from "../src/index.js";

const w = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const cur = (id: string, wallets: string[], related: Record<string, { address: string; relation: string }[]> = {}): ClusterCurator => ({ id, wallets, related });

describe("findClusters", () => {
  test("a shared funder joins two curators", () => {
    const c = findClusters([cur("a", [w(1)], { [w(1)]: [{ address: w(99), relation: "First Funder" }] }), cur("b", [w(2)], { [w(2)]: [{ address: w(99), relation: "First Funder" }] }), cur("c", [w(3)])]);
    expect(c).toHaveLength(1);
    expect(c[0]!.members).toEqual(["a", "b"]);
  });
  test("one wallet funding another curator's wallet joins them directly", () => {
    const c = findClusters([cur("a", [w(1)], { [w(1)]: [{ address: w(2), relation: "Funded" }] }), cur("b", [w(2)])]);
    expect(c[0]!.members).toEqual(["a", "b"]);
    expect(c[0]!.reasons[0]!.why).toContain("Funded");
  });
  test("links are transitive", () => {
    const rel = (x: number) => ({ [w(x)]: [{ address: w(x + 1), relation: "r" }] });
    const c = findClusters([cur("a", [w(1)], rel(1)), cur("b", [w(2)], { ...rel(2), [w(2)]: [{ address: w(3), relation: "r" }] }), cur("c", [w(3)])]);
    expect(c[0]!.members).toEqual(["a", "b", "c"]);
  });
  test("unrelated curators and curators without linked wallets make no cluster", () => {
    expect(findClusters([cur("a", [w(1)], { [w(1)]: [{ address: w(7), relation: "x" }] }), cur("b", [w(2)], { [w(2)]: [{ address: w(8), relation: "x" }] }), cur("c", [])])).toEqual([]);
  });
});
