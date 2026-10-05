/**
 * Sybil clusters: curators whose linked mainnet identity wallets are connected by Nansen's related-wallets data (a shared
 * funder or deployer, or one wallet appearing in the other's relations). Pure function over stored Nansen results.
 * Two curators in one cluster may well be one person running several accounts: the ranking page flags it, it does not ban anyone.
 */
export interface ClusterCurator {
  id: string;
  wallets: string[]; // linked identity wallets, lower case
  related: Record<string, { address: string; relation: string }[]>; // per linked wallet, from Nansen
}

export interface Cluster {
  members: string[]; // curator ids, sorted
  reasons: { a: string; b: string; why: string }[];
}

export function findClusters(curators: ClusterCurator[]): Cluster[] {
  const parent = new Map<string, string>(curators.map((c) => [c.id, c.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const reasons: Cluster["reasons"] = [];
  for (let i = 0; i < curators.length; i++) {
    for (let j = i + 1; j < curators.length; j++) {
      const a = curators[i]!, b = curators[j]!;
      const why = linkWhy(a, b);
      if (!why) continue;
      reasons.push({ a: a.id, b: b.id, why });
      parent.set(find(a.id), find(b.id));
    }
  }
  const groups = new Map<string, string[]>();
  for (const c of curators) { const r = find(c.id); groups.set(r, [...(groups.get(r) ?? []), c.id]); }
  return [...groups.values()].filter((m) => m.length > 1).map((m) => ({ members: m.sort(), reasons: reasons.filter((r) => m.includes(r.a)) })).sort((x, y) => (x.members[0]! < y.members[0]! ? -1 : 1));
}

function linkWhy(a: ClusterCurator, b: ClusterCurator): string | null {
  const relOf = (c: ClusterCurator) => Object.entries(c.related).flatMap(([w, rs]) => rs.map((r) => ({ from: w, ...r })));
  const ra = relOf(a), rb = relOf(b);
  for (const r of ra) if (b.wallets.includes(r.address)) return `${short(r.from)} is "${r.relation}" ${short(r.address)}`;
  for (const r of rb) if (a.wallets.includes(r.address)) return `${short(r.from)} is "${r.relation}" ${short(r.address)}`;
  for (const x of ra) for (const y of rb) if (x.address === y.address) return `both wallets are related to ${short(x.address)} ("${x.relation}" / "${y.relation}")`;
  return null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
