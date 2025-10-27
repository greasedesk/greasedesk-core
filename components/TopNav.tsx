/**
 * File: components/TopNav.tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 */
import Link from "next/link";

export default function TopNav() {
  return (
    <header className="bg-gdBg border-b border-gdBorder text-gdText">
      <div className="mx-auto max-w-full flex items-center justify-between px-4 py-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-gdText">GreaseDesk</span>
          <nav className="flex items-center gap-4 text-gdSubtext">
            <Link
              className="hover:text-gdAccent transition-colors"
              href="/bookings"
            >
              Bookings
            </Link>
            <Link
              className="hover:text-gdAccent transition-colors"
              href="/jobcard/1234"
            >
              Job Card
            </Link>
          </nav>
        </div>
        <div className="text-xs text-gdSubtext">
          The Mini & BMW Specialist
        </div>
      </div>
    </header>
  );
}
