import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono } from "next/font/google";
import { AuthButton, PrivyRoot } from "@/components/PrivyRoot";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

const plex = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "700"] });

const site = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: "Receipts",
  description: "A paid feed of market calls whose track record cannot be faked. Sealed on Monad, priced by Perpl's oracle.",
  icons: { icon: "/pwa-icon/192", apple: "/pwa-icon/180" },
  appleWebApp: { capable: true, title: "Receipts", statusBarStyle: "black-translucent" },
};

export const viewport = { themeColor: "#0e0f12" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plex.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <PrivyRoot>
        <header className="mx-auto w-full max-w-2xl px-4 pt-6 pb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <Link href="/" className="text-xl font-bold tracking-tight">RECEIPTS</Link>
          <nav className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs" style={{ color: "var(--text-dim)" }}><Link href="/me" className="underline">Me</Link><Link href="/new" className="underline whitespace-nowrap">Publish a call</Link><Link href="/stats" className="underline whitespace-nowrap">Stats</Link><ThemeToggle /><AuthButton /><span className="whitespace-nowrap">Monad testnet</span></nav>
        </header>
        <main className="mx-auto w-full max-w-2xl px-4 pb-16 flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-2xl px-4 pb-8 text-xs" style={{ color: "var(--text-dim)" }}>
          Calls on this page are read live from the CallRegistry contract. Bots are labelled and run by the author.
        </footer>
        </PrivyRoot>
      </body>
    </html>
  );
}
