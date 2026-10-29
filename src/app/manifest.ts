import type { MetadataRoute } from "next";

/** PWA manifest (installable member app; the scanner has its own start URL via /scan?source=pwa). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SIAPP — Sorry, it's a private party",
    short_name: "SIAPP",
    description: "Keys open doors. Members-only nightlife in Lisbon.",
    id: "/app",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#141414",
    theme_color: "#141414",
    lang: "en",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    shortcuts: [
      { name: "My tickets", url: "/app/tickets", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Scanner", url: "/scan", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
