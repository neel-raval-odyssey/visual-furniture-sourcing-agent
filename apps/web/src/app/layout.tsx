import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Visual Furniture Sourcing Agent",
  description:
    "Find Alibaba listings that match a reference furniture photograph, ranked by design similarity.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}
