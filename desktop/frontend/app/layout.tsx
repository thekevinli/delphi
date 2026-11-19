import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Delphi — less climb, same summit",
  description:
    "Ask a research paper what it says instead of scrolling for it. Every answer cites the page it came from, so the reading gets shorter without the understanding getting thinner.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
