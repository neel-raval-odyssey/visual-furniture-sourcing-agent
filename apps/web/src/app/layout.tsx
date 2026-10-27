import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Visual Furniture Sourcing", template: "%s · Visual Furniture Sourcing" },
  description: "Find furniture designs across global suppliers using visual intelligence.",
};

export const viewport: Viewport = { themeColor: "#faf8f4" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ivory text-ink antialiased">{children}</body>
    </html>
  );
}
