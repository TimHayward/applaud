import { useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { SyncStatusBadge } from "./SyncStatusBadge.js";
import { ThemeToggle } from "./ThemeToggle.js";

function useStarNudge(): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(false);
  const location = useLocation();
  const counted = useRef(false);

  useEffect(() => {
    if (location.pathname !== "/" || counted.current) return;
    counted.current = true;

    if (localStorage.getItem("applaud-star-dismissed")) return;

    const visits = parseInt(localStorage.getItem("applaud-dashboard-visits") ?? "0", 10) + 1;
    localStorage.setItem("applaud-dashboard-visits", String(visits));

    if (visits === 3) setShow(true);
  }, [location.pathname]);

  const dismiss = (): void => {
    setShow(false);
    localStorage.setItem("applaud-star-dismissed", "1");
  };

  return { show, dismiss };
}

export function AppShell(): JSX.Element {
  const { show: showNudge, dismiss: dismissNudge } = useStarNudge();
  const ghRef = useRef<HTMLAnchorElement>(null);

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-10 border-b border-outline-variant/20 bg-surface-dim/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 h-16">
          <div className="flex items-center gap-10">
            <NavLink to="/" className="text-2xl font-black text-on-surface">
              Applaud<span className="text-primary">.</span>
            </NavLink>
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  isActive
                    ? "text-primary font-bold border-b-2 border-primary pb-1"
                    : "text-on-surface-variant hover:text-on-surface transition-colors"
                }
              >
                Recordings
              </NavLink>
              <NavLink
                to="/trash"
                className={({ isActive }) =>
                  isActive
                    ? "text-primary font-bold border-b-2 border-primary pb-1"
                    : "text-on-surface-variant hover:text-on-surface transition-colors"
                }
              >
                Trash
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) =>
                  isActive
                    ? "text-primary font-bold border-b-2 border-primary pb-1"
                    : "text-on-surface-variant hover:text-on-surface transition-colors"
                }
              >
                Settings
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <SyncStatusBadge />
            <div className="relative">
              <a
                ref={ghRef}
                href="https://github.com/rsteckler/applaud"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg p-1.5 text-on-surface-variant hover:text-on-surface transition-colors block"
                title="View on GitHub"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </a>
              {showNudge && (
                <div className="absolute top-full right-0 mt-2 w-64 z-50 animate-in fade-in slide-in-from-top-2">
                  {/* Arrow */}
                  <div className="absolute -top-1.5 right-3 w-3 h-3 rotate-45 bg-surface-container-high border-l border-t border-outline-variant/30" />
                  <div className="bg-surface-container-high border border-outline-variant/30 rounded-xl p-4 shadow-xl">
                    <p className="text-sm text-on-surface leading-relaxed">
                      Enjoying Applaud? I'd really appreciate a
                      {" "}
                      <a
                        href="https://github.com/rsteckler/applaud"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary font-semibold hover:underline"
                      >
                        star on GitHub
                      </a>
                      !
                    </p>
                    <button
                      onClick={dismissNudge}
                      className="mt-3 text-xs text-on-surface-variant hover:text-on-surface transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
