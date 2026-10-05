import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const plex = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "700"] });

export const metadata: Metadata = {
  title: "Receipts",
  description: "A paid feed of market calls whose track record cannot be faked. Sealed on Monad, priced by Perpl's oracle.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plex.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <header className="mx-auto w-full max-w-2xl px-4 pt-6 pb-2 flex items-baseline justify-between">
          <Link href="/" className="text-xl font-bold tracking-tight">RECEIPTS</Link>
          <nav className="flex items-baseline gap-4 text-xs" style={{ color: "var(--text-dim)" }}><Link href="/new" className="underline">Publish a call</Link><span>Monad testnet</span></nav>
        </header>
        <main className="mx-auto w-full max-w-2xl px-4 pb-16 flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-2xl px-4 pb-8 text-xs" style={{ color: "var(--text-dim)" }}>
          Calls on this page are read live from the CallRegistry contract. Bots are labelled and run by the author.
        </footer>
      </body>
    </html>
  );
}
