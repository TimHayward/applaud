import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { formatDateShort } from "../lib/format.js";
import { SpeakerStatusDot, useSpeakerStatuses } from "./SpeakerStatus.js";

const PAGE = 50;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 520;

/**
 * Other recordings, newest first, beside a recording's page: each with the
 * colour of its speaker status. Resized by dragging its right edge.
 */
export function RecordingsSidebar({
  currentId,
  width,
  onResize,
  onHide,
}: {
  currentId: string;
  width: number;
  onResize: (width: number) => void;
  onHide: () => void;
}): JSX.Element {
  const statusOf = useSpeakerStatuses();
  const list = useInfiniteQuery({
    queryKey: ["recordings-sidebar"],
    queryFn: ({ pageParam }) => api.listRecordings({ limit: PAGE, offset: pageParam, sort: "date_desc" }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    staleTime: 30_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  // Keep the open recording in view when it changes.
  const currentRef = useRef<HTMLAnchorElement>(null);
  const loaded = items.length > 0;
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [currentId, loaded]);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent): void => {
      onResize(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX)));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside
      className="hidden lg:flex fixed left-0 top-16 bottom-0 z-[5] flex-col border-r border-outline-variant/20 bg-surface"
      style={{ width }}
      aria-label="Recordings"
    >
      <div className="flex items-center justify-between px-4 h-12 shrink-0 border-b border-outline-variant/20">
        <span className="text-xs font-semibold uppercase tracking-widest text-on-surface-variant font-label">
          Recordings
        </span>
        <button
          type="button"
          className="rounded-lg p-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
          onClick={onHide}
          title="Hide the recordings list"
          aria-label="Hide the recordings list"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {list.isLoading && <p className="px-4 py-2 text-xs text-on-surface-variant">Loading…</p>}
        {list.isError && <p className="px-4 py-2 text-xs text-error">Couldn't load recordings.</p>}
        <ul>
          {items.map((r) => {
            const current = r.id === currentId;
            return (
              <li key={r.id}>
                <Link
                  ref={current ? currentRef : undefined}
                  to={`/recordings/${r.id}`}
                  aria-current={current ? "page" : undefined}
                  className={`flex items-start gap-2.5 px-4 py-2 text-sm transition-colors ${
                    current ? "bg-primary/10 text-primary" : "text-on-surface hover:bg-surface-container"
                  }`}
                >
                  <span className="mt-1.5">
                    <SpeakerStatusDot status={statusOf(r.id)} />
                  </span>
                  <span className="min-w-0">
                    <span className={`block truncate ${current ? "font-semibold" : ""}`}>{r.displayName ?? r.filename}</span>
                    <span className="block font-label text-[10px] uppercase tracking-wider text-on-surface-variant">
                      {formatDateShort(r.startTime)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {list.hasNextPage && (
          <button
            type="button"
            className="mx-4 my-2 text-xs text-primary hover:underline disabled:opacity-50"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "Loading…" : "Show more"}
          </button>
        )}
      </nav>
      <div
        className="absolute top-0 right-0 h-full w-1.5 -mr-0.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/40"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the recordings list"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onResize(Math.max(SIDEBAR_MIN, width - 16));
          if (e.key === "ArrowRight") onResize(Math.min(SIDEBAR_MAX, width + 16));
        }}
      />
    </aside>
  );
}
