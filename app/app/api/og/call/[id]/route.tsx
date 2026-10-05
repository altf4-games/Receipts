import { ImageResponse } from "next/og";
import { getCallView } from "@/lib/calls";
import { deploymentOf } from "@/lib/hash";

export const dynamic = "force-dynamic";

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

/** A receipt rendered as an image, from live chain data. */
export async function GET(req: Request, ctx: RouteContext<"/api/og/call/[id]">) {
  const dep = deploymentOf(new URL(req.url).searchParams.get("deployment"));
  const c = await getCallView(Number((await ctx.params).id), dep);
  if (!c) return new Response("not found", { status: 404 });
  const stamp =
    c.status === "Settled" ? `${pct(c.scoreBps ?? 0)} SETTLED` : c.status === "Expired" ? `EXPIRED ${pct(c.scoreBps ?? 0)}` : c.status === "Invalid" ? "INVALID" : c.status.toUpperCase();
  const stampColor = c.status === "Settled" && (c.scoreBps ?? 0) >= 0 ? "#1f7a45" : c.status === "Revealed" ? "#6b6a66" : "#c8321f";
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, marginTop: 10 }}>
      <span style={{ color: "#6d6a5e" }}>{k}</span><span>{v}</span>
    </div>
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: "#0e0f12", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace" }}>
        <div style={{ width: 640, height: 560, background: "#f4f0e4", color: "#1b1a17", padding: "36px 44px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ display: "flex", flexDirection: "column", maxWidth: 380 }}>
              <span style={{ fontSize: 40, fontWeight: 700 }}>#{c.id} · {c.market}{c.direction ? ` ${c.direction}` : ""}</span>
              <span style={{ fontSize: 26, color: "#6d6a5e" }}>{c.handle}{c.isBot ? " [BOT]" : ""}</span>
            </div>
            <div style={{ border: `4px solid ${stampColor}`, color: stampColor, padding: "2px 14px", fontSize: 28, fontWeight: 700, transform: "rotate(-4deg)" }}>{stamp}</div>
          </div>
          <div style={{ borderTop: "2px dashed #cfc9b6", margin: "22px 0 8px" }} />
          {row("Entry (oracle)", c.entryPrice)}
          {row("Sealed", new Date(c.commitTime * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z")}
          {row("Block", c.commitBlock.toString())}
          {c.tpBps !== null && row("Take profit", pct(c.tpBps))}
          {c.slBps !== null && row("Stop loss", pct(-c.slBps))}
          {c.status === "Sealed" && row("Call", "hidden until revealed")}
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 22, color: "#6d6a5e" }}>RECEIPTS · sealed on Monad</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
