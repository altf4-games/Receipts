/**
 * Tiny Cloudflare Worker whose ONLY job is to start the GitHub Actions keeper workflow every 5 minutes.
 * GitHub's own `schedule` trigger proved unreliable (a brand-new workflow did not fire for 2+ hours on 2026-10-06), and the
 * heavy keeper tick is too CPU-hungry for the Workers Free plan (docs/bugs.md). One authenticated fetch costs about 1 ms
 * of CPU, far below the 10 ms limit. The token is a fine-grained GitHub token limited to this repo with only
 * "Actions: Read and write" (Worker secret GH_TOKEN, never in the repo).
 */
export interface Env { GH_TOKEN: string; REPO: string; WORKFLOW: string; REF: string }

async function dispatch(env: Env): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "receipts-dispatch",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.REF }),
  });
  const line = `dispatch ${env.REPO}/${env.WORKFLOW}@${env.REF} -> HTTP ${res.status}`;
  console.log(JSON.stringify({ evt: "dispatch", status: res.status, at: new Date().toISOString() }));
  if (res.status !== 204) throw new Error(`${line}: ${(await res.text()).slice(0, 200)}`);
  return line;
}

export default {
  async scheduled(_c: unknown, env: Env): Promise<void> { await dispatch(env); },
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/dispatch" && req.method === "POST" && req.headers.get("x-admin") === env.GH_TOKEN.slice(-8)) return new Response((await dispatch(env)) + "\n");
    return new Response("receipts-dispatch: starts the keeper workflow every 5 minutes\n");
  },
};
