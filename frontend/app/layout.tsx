import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rebar Shape Finder",
  description: "Find rebar shapes and their lengths in a CAD PDF",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
