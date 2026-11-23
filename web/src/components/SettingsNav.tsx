import { useEffect, useMemo, useState } from "react";

export interface SettingsSection {
  id: string;
  label: string;
}

/** The Settings sections, in page order. Each id is on its section's element. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "sync-status", label: "Sync status" },
  { id: "sync-maintenance", label: "Sync maintenance" },
  { id: "account", label: "Account" },
  { id: "lan-access", label: "LAN access" },
  { id: "webhook", label: "Webhook" },
  { id: "poll-interval", label: "Poll interval" },
  { id: "history-window", label: "History window" },
  { id: "speakers", label: "Speaker identification" },
  { id: "automatic-plaud-sync", label: "Automatic Plaud sync" },
];

/** The section nearest the top of the viewport, below the sticky header. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    const update = (): void => {
      // At the bottom of the page the last sections can't reach the top: pick the last.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        setActive(ids[ids.length - 1] ?? null);
        return;
      }
      let current: string | null = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 140) current = id;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);
  return active;
}

function go(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  history.replaceState(null, "", `#${id}`);
}

/**
 * Settings navigation: a sticky list beside the page on wide screens, a
 * scrolling row of links above it on narrow ones.
 */
export function SettingsNav({
  sections = SETTINGS_SECTIONS,
  variant,
}: {
  sections?: SettingsSection[];
  variant: "side" | "top";
}): JSX.Element {
  const ids = useMemo(() => sections.map((s) => s.id), [sections]);
  const active = useActiveSection(ids);
  // A link to a section (/settings#webhook): go there once the page has rendered.
  useEffect(() => {
    if (variant !== "side") return;
    const id = window.location.hash.slice(1);
    if (ids.includes(id)) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [ids, variant]);
  const link = (s: SettingsSection): JSX.Element => {
    const on = s.id === active;
    return (
      <a
        key={s.id}
        href={`#${s.id}`}
        aria-current={on ? "location" : undefined}
        onClick={(e) => {
          e.preventDefault();
          go(s.id);
        }}
        className={
          variant === "side"
            ? `block rounded-lg px-3 py-2 text-sm transition-colors ${
                on
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
              }`
            : `shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                on
                  ? "bg-primary/10 text-primary"
                  : "bg-surface-container-low text-on-surface-variant hover:text-on-surface"
              }`
        }
      >
        {s.label}
      </a>
    );
  };

  if (variant === "top") {
    return (
      <nav aria-label="Settings sections" className="lg:hidden -mx-6 px-6 overflow-x-auto">
        <div className="flex gap-2 pb-2">{sections.map(link)}</div>
      </nav>
    );
  }
  return (
    <nav aria-label="Settings sections" className="hidden lg:block sticky top-28 self-start">
      <p className="px-3 mb-2 font-label text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">
        Settings
      </p>
      <div className="space-y-0.5">{sections.map(link)}</div>
    </nav>
  );
}
