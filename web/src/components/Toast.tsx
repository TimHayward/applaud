import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { toastDurationMs, type ToastKind } from "../lib/toastDuration.js";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({
  success: () => {},
  error: () => {},
  info: () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId++;
      setItems((prev) => [...prev, { id, kind, message }]);
      // `null` = stays until dismissed (long errors) — see toastDuration.ts.
      const ms = toastDurationMs(kind, message);
      if (ms != null) setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const api: ToastApi = {
    success: (m) => push("success", m),
    error: (m) => push("error", m),
    info: (m) => push("info", m),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-atomic lives on each toast, not the list: on the list it made a
          new toast re-announce every toast still on screen. */}
      <div
        className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 items-end pointer-events-none"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            // Errors interrupt (assertive) — they're the ones that change what
            // the user should do next, and they may not auto-dismiss.
            role={t.kind === "error" ? "alert" : "status"}
            aria-live={t.kind === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`pointer-events-auto max-w-sm rounded-lg px-4 py-3 text-sm font-medium shadow-lg border flex items-start gap-3 ${
              t.kind === "success"
                ? "bg-secondary/15 border-secondary/30 text-secondary"
                : t.kind === "error"
                  ? "bg-error/15 border-error/30 text-error"
                  : "bg-surface-container-high border-outline-variant/30 text-on-surface"
            }`}
          >
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              className="opacity-60 hover:opacity-100 transition-opacity shrink-0"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
