import type { ReactNode } from "react";
import Link from "next/link";
import { ClerkProvider, OrganizationSwitcher, SignedIn, UserButton } from "@clerk/nextjs";
import "./globals.css";

export const metadata = {
  title: "ARF-OS",
  description: "AI Research Hedge Fund Operating System — strategy research console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <SignedIn>
            <header className="app-header">
              <Link href="/" className="app-brand">
                ARF-OS
                <span className="app-brand-mark">research console</span>
              </Link>
              <nav className="app-nav">
                <Link href="/">Command Centre</Link>
                <Link href="/strategies">Strategy Library</Link>
                <Link href="/algos">Algo Library</Link>
                <Link href="/practice-arena">Practice Arena</Link>
                <Link href="/portfolio-research">Portfolio Research</Link>
              </nav>
              <div className="app-header-spacer" />
              <div className="app-header-actions">
                <OrganizationSwitcher
                  hidePersonal
                  createOrganizationMode="modal"
                  afterCreateOrganizationUrl="/"
                  afterSelectOrganizationUrl="/"
                />
                <UserButton />
              </div>
            </header>
          </SignedIn>
          <main className="app-main">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
