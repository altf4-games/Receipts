"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Re-reads the page's server data every `seconds` while the tab is visible, with a small indicator so it is clear the feed is live. */
export function LiveRefresh({ seconds = 12 }: { seconds?: number }) {
  const router = useRouter();
  const [at, setAt] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    setAt(new Date());
    const tick = () => { if (document.visibilityState === "visible") { router.refresh(); setAt(new Date()); setPaused(false); } else setPaused(true); };
    const id = setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [router, seconds]);
  return (
    <span className="text-xs" style={{ color: "var(--text-dim)" }} role="status" aria-live="off">
      <span aria-hidden style={{ color: paused ? "var(--text-dim)" : "var(--stamp-green)" }}>●</span> {paused ? "paused" : "live"}{at ? ` · updated ${at.toLocaleTimeString()}` : ""}
    </span>
  );
}
