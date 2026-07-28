import { useCallback, useRef } from "react";

/**
 * Remembers what had focus before an overlay opened, and puts it back when the
 * overlay closes. Without this, dismissing a dialog drops focus to `<body>`
 * and a keyboard user has to tab from the top of the page again.
 *
 * `capture()` is called from the handler that opens the overlay rather than
 * from an effect, so it always records the real opener — by the time an effect
 * runs, the dialog's own initial focus (`autoFocus`, or a `.focus()` call) has
 * often already moved `document.activeElement`.
 */
export function useFocusReturn(): { capture: () => void; restore: () => void } {
  const previous = useRef<HTMLElement | null>(null);

  const capture = useCallback(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const restore = useCallback(() => {
    const el = previous.current;
    previous.current = null;
    // The opener can be gone by now (e.g. a row removed by the action the
    // dialog confirmed) — focusing a detached node would throw focus away.
    if (el?.isConnected) el.focus();
  }, []);

  return { capture, restore };
}
