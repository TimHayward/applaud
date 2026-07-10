import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { useToast } from "./Toast.js";

const PROSE_CLASSES =
  "prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed text-on-surface [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-on-surface [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-on-surface [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-on-surface [&_p]:text-on-surface-variant [&_li]:text-on-surface-variant [&_strong]:text-on-surface [&_a]:text-primary [&_ul]:space-y-1 [&_ol]:space-y-1";

function SummaryTitle({ id }: { id?: string }): JSX.Element {
  return (
    <h2 id={id} className="text-sm font-label uppercase tracking-widest text-tertiary flex items-center gap-2 font-semibold">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
      AI Summary
    </h2>
  );
}

/** AI-summary sidebar card with copy-to-clipboard and an accessible expand modal. */
export function SummaryPanel({ markdown }: { markdown: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const toast = useToast();

  // Modal a11y: focus the close button on open, Escape to close, and trap
  // Tab focus inside the dialog while it's up.
  useEffect(() => {
    if (!expanded) return;
    closeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setExpanded(false);
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>("button, a[href]");
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
  }, [expanded]);

  const copySummary = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Summary copied to clipboard.");
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  };

  return (
    <>
      <section className="bg-surface-container-high rounded-xl p-6 shadow-lg border border-outline-variant/20 relative">
        <div className="flex items-center justify-between mb-4">
          <SummaryTitle />
          <div className="flex items-center gap-1">
            <button
              onClick={() => void copySummary()}
              className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
              title="Copy summary markdown"
              aria-label="Copy summary markdown"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            </button>
            <button
              onClick={() => setExpanded(true)}
              className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
              title="Expand summary"
              aria-label="Expand summary"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </div>
        </div>
        <div className="overflow-hidden relative" style={{ maxHeight: "50vh" }}>
          <div className={PROSE_CLASSES}>
            <Markdown>{markdown}</Markdown>
          </div>
          {/* Fade overlay at bottom */}
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-surface-container-high to-transparent pointer-events-none" />
        </div>
      </section>

      {/* Expanded modal */}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={() => setExpanded(false)}>
          <div className="absolute inset-0 bg-surface/80 backdrop-blur-sm" />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="summary-dialog-title"
            className="relative bg-surface-container-high rounded-2xl border border-outline-variant/20 shadow-2xl w-full max-w-4xl"
            style={{ maxHeight: "90vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-6 border-b border-outline-variant/30">
              <SummaryTitle id="summary-dialog-title" />
              <button
                ref={closeRef}
                onClick={() => setExpanded(false)}
                className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
                title="Close"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto p-6" style={{ maxHeight: "calc(90vh - 73px)" }}>
              <div className={PROSE_CLASSES}>
                <Markdown>{markdown}</Markdown>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
