import type { ReactNode } from "react";

export const metadata = {
  title: "ARF-OS",
  description: "AI Research Hedge Fund Operating System — strategy research console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
