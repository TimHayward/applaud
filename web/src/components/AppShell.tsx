import { Outlet, NavLink } from "react-router-dom";
import { SyncStatusBadge } from "./SyncStatusBadge.js";

export function AppShell(): JSX.Element {
  return (
    <div className="min-h-screen bg-ink-50">
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" />
            applaud
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm ${
                  isActive ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100"
                }`
              }
            >
              Recordings
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm ${
                  isActive ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100"
                }`
              }
            >
              Settings
            </NavLink>
            <div className="ml-3">
              <SyncStatusBadge />
            </div>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
