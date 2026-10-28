import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";

import "@/styles/globals.css";

// DM Sans is the face dealt by the design sheet: a grotesk with enough
// character to look like a product rather than a framework default.
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "CW Social Publisher",
    template: "%s · CW Social Publisher",
  },
  description: "ColorWhistle's internal console for publishing to client social accounts.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f8f8f8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body>{children}</body>
    </html>
  );
}
