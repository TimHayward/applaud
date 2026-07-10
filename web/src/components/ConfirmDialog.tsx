import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

/** Promise-based replacement for window.confirm() with proper dialog semantics. */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ options, resolve });
    });
  }, []);

  const close = useCallback(
    (result: boolean) => {
      pending?.resolve(result);
      setPending(null);
    },
    [pending],
  );

  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        close(false);
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>("button");
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-6"
          onClick={() => close(false)}
        >
          <div className="absolute inset-0 bg-surface/80 backdrop-blur-sm" />
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            className="relative bg-surface-container-high rounded-2xl border border-outline-variant/20 shadow-2xl w-full max-w-md p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-dialog-title" className="text-lg font-bold text-on-surface">
              {pending.options.title}
            </h2>
            <p id="confirm-dialog-message" className="text-sm text-on-surface-variant whitespace-pre-line">
              {pending.options.message}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                ref={cancelRef}
                type="button"
                className="btn-ghost px-4 py-2 text-sm"
                onClick={() => close(false)}
              >
                {pending.options.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={
                  pending.options.destructive
                    ? "px-4 py-2 text-sm rounded-lg border border-error/30 text-error font-semibold hover:bg-error/10 transition-colors"
                    : "btn-primary px-4 py-2 text-sm"
                }
                onClick={() => close(true)}
              >
                {pending.options.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
