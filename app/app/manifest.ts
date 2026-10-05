import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Receipts",
    short_name: "Receipts",
    description: "A paid feed of market calls that can't be deleted or backdated. Sealed on Monad.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e0f12",
    theme_color: "#0e0f12",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
