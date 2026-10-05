import { ImageResponse } from "next/og";

/** The Receipts mark: a torn paper slip with a red stamp. Used by the web app manifest and as the project logo. */
export async function GET(_req: Request, ctx: RouteContext<"/pwa-icon/[size]">) {
  const size = Number((await ctx.params).size);
  if (![180, 192, 512, 1024].includes(size)) return new Response("not found", { status: 404 });
  const s = size;
  return new ImageResponse(
    (
      <div style={{ width: s, height: s, background: "#0e0f12", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width={s * 0.72} height={s * 0.82} viewBox="0 0 72 82" xmlns="http://www.w3.org/2000/svg">
          <path d="M0 0H72V76L66 70L60 76L54 70L48 76L42 70L36 76L30 70L24 76L18 70L12 76L6 70L0 76Z" fill="#f4f0e4" />
          <rect x="10" y="12" width="30" height="4" fill="#1b1a17" />
          <rect x="10" y="22" width="52" height="3" fill="#cfc9b6" />
          <rect x="10" y="30" width="52" height="3" fill="#cfc9b6" />
          <rect x="10" y="38" width="40" height="3" fill="#cfc9b6" />
          <g transform="rotate(-8 41 56)">
            <rect x="16" y="46" width="50" height="20" fill="none" stroke="#c8321f" strokeWidth="3" />
            <rect x="21" y="52" width="40" height="8" fill="#c8321f" />
          </g>
        </svg>
      </div>
    ),
    { width: s, height: s },
  );
}
