import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata = {
  title: "ARF-OS",
  description: "AI Research Hedge Fund Operating System — strategy research console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
