import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Comfortaa } from "next/font/google";
import { Providers } from "@/components/providers";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const comfortaa = Comfortaa({
  variable: "--font-comfortaa",
  weight: "700",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "flow",
  description: "Self-hosted household budget, debt payoff, and net worth tracker.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "flow",
  },
};

export const viewport: Viewport = {
  themeColor: "#1e3a8a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${comfortaa.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          // Runs before paint to avoid a flash of the wrong theme — reads
          // the persisted choice and applies the class the same way
          // ThemeProvider does on every later change. "system" (the
          // default) is represented by *no* stored key, not a "system"
          // string — see theme-provider.tsx's setTheme — so an absent key
          // here correctly falls through to the live OS preference.
          dangerouslySetInnerHTML={{
            __html: `try {
  var t = localStorage.getItem("flow-theme");
  if (!t) t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (t === "dark") document.documentElement.classList.add("dark");
} catch (e) {}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <Providers>{children}</Providers>
        <ServiceWorkerRegistration />
        {/* The old floating "Install Flow" popup lived here, on every route
            including /login (household report, 2026-09-11 — it had no
            business appearing before sign-in anyway). Replaced by a badge
            on the profile icon + a proper Settings > Install Flow card
            (ProfileMenu, settings/install-app-card.tsx) — see
            use-install-status.ts for the shared detection logic both use. */}
      </body>
    </html>
  );
}
