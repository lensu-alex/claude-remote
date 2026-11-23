import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Montserrat } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

// Heavy capitals for titles, numbers and labels (--font-display in globals.css).
const heavy = Montserrat({ subsets: ["latin", "latin-ext"], variable: "--font-heavy", display: "swap" });

export const metadata: Metadata = {
  title: "Claude Remote",
  description: "Start and check on Claude Code tasks running on your laptop.",
  applicationName: "Claude Remote",
  appleWebApp: { capable: true, title: "Claude Remote", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1e9" },
    { media: "(prefers-color-scheme: dark)", color: "#130c07" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={heavy.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
