import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { parseTranscript, type TranscriptBlock } from "../lib/transcript.js";
import { useFocusReturn } from "../hooks/useFocusReturn.js";
import { useToast } from "./Toast.js";

// Defined in index.css (:root) so the palette lives in one theme-owned place
// instead of being duplicated as literal hex here.
const SPEAKER_COLORS = Array.from({ length: 12 }, (_, i) => `var(--speaker-color-${i + 1})`);
const UNKNOWN_COLOR = "var(--speaker-color-unknown)";

function isUnknownSpeaker(speaker: string): boolean {
  return /^speaker\s*\d*$/i.test(speaker.trim());
}

function speakerColor(speaker: string, map: Map<string, string>): string {
  if (isUnknownSpeaker(speaker)) return UNKNOWN_COLOR;
  if (!map.has(speaker)) {
    map.set(speaker, SPEAKER_COLORS[map.size % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0]!);
  }
  return map.get(speaker) ?? SPEAKER_COLORS[0]!;
}

// --- Search helpers ---

interface SearchMatch {
  blockIndex: number;
  startChar: number;
  length: number;
}

function findAllMatches(blocks: TranscriptBlock[], query: string): SearchMatch[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const text = (blocks[bi]?.text ?? "").toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = text.indexOf(lower, pos);
      if (idx === -1) break;
      matches.push({ blockIndex: bi, startChar: idx, length: query.length });
      pos = idx + 1;
    }
  }
  return matches;
}

function HighlightedText({
  text,
  matches,
  activeMatchIndex,
  globalOffset,
}: {
  text: string;
  matches: SearchMatch[];
  activeMatchIndex: number;
  globalOffset: number;
}): JSX.Element {
  if (matches.length === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    if (m.startChar > cursor) {
      parts.push(<span key={`t${cursor}`}>{text.slice(cursor, m.startChar)}</span>);
    }
    const isActive = globalOffset + i === activeMatchIndex;
    parts.push(
      <mark
        key={`m${m.startChar}`}
        className={`rounded px-0.5 ${
          isActive ? "bg-primary text-on-primary" : "bg-primary/25 text-on-surface"
        }`}
      >
        {text.slice(m.startChar, m.startChar + m.length)}
      </mark>,
    );
    cursor = m.startChar + m.length;
  }
  if (cursor < text.length) {
    parts.push(<span key={`t${cursor}`}>{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

// --- Transcript card with search, click-to-seek, and playback follow ---

export function TranscriptCard({
  text,
  currentTime,
  onSeek,
}: {
  text: string;
  currentTime: number;
  onSeek: (seconds: number) => void;
}): JSX.Element {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Map<number, HTMLElement>>(new Map());
  const toast = useToast();
  const blocks = useMemo(() => parseTranscript(text), [text]);
  const speakerMap = useMemo(() => new Map<string, string>(), []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [isHovering, setIsHovering] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocus = useFocusReturn();

  const openSearch = useCallback((): void => {
    searchFocus.capture();
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [searchFocus]);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setSearchQuery("");
    searchFocus.restore();
  }, [searchFocus]);

  const allMatches = useMemo(() => findAllMatches(blocks, searchQuery), [blocks, searchQuery]);

  useEffect(() => { setActiveMatch(0); }, [searchQuery]);

  // Scroll to active search match
  useEffect(() => {
    if (allMatches.length === 0 || activeMatch < 0) return;
    const m = allMatches[activeMatch];
    if (!m) return;
    const el = blockRefs.current.get(m.blockIndex);
    if (el && transcriptRef.current) {
      const container = transcriptRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      container.scrollTo({ top: elTop - 60, behavior: "smooth" });
    }
  }, [activeMatch, allMatches]);

  const goNext = useCallback(() => {
    if (allMatches.length === 0) return;
    setActiveMatch((a) => (a + 1) % allMatches.length);
  }, [allMatches.length]);

  const goPrev = useCallback(() => {
    if (allMatches.length === 0) return;
    setActiveMatch((a) => (a - 1 + allMatches.length) % allMatches.length);
  }, [allMatches.length]);

  // Ctrl/Cmd+F opens in-card search while the transcript is "engaged" — the
  // pointer is over it, or focus is inside it. Hover alone locked keyboard-only
  // users out entirely; outside those cases the browser's native find-in-page
  // is left alone.
  useEffect(() => {
    if (!isHovering && !isFocusWithin) return;
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isHovering, isFocusWithin, openSearch]);

  const handleSearchKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") { closeSearch(); }
    else if (e.key === "Enter" && e.shiftKey) { goPrev(); }
    else if (e.key === "Enter") { goNext(); }
  };

  const copyTranscript = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Transcript copied to clipboard.");
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  };

  // Per-block match data with global offset
  const blockMatchMap = useMemo(() => {
    const map = new Map<number, { matches: SearchMatch[]; globalOffset: number }>();
    let offset = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const bm = allMatches.filter((m) => m.blockIndex === bi);
      if (bm.length > 0) {
        map.set(bi, { matches: bm, globalOffset: offset });
        offset += bm.length;
      }
    }
    return map;
  }, [allMatches, blocks.length]);

  // Active playback block
  const activeIndex = useMemo(() => {
    if (blocks.length === 0) return -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (currentTime >= (blocks[i]?.seconds ?? 0)) return i;
    }
    return -1;
  }, [blocks, currentTime]);

  // Auto-scroll to active playback block (only when not searching)
  useEffect(() => {
    if (searchQuery) return;
    if (activeIndex < 0) return;
    const el = blockRefs.current.get(activeIndex);
    if (el && transcriptRef.current) {
      const container = transcriptRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const scrollTop = container.scrollTop;
      const viewHeight = container.clientHeight;
      if (elTop < scrollTop || elBottom > scrollTop + viewHeight) {
        container.scrollTo({ top: elTop - 40, behavior: "smooth" });
      }
    }
  }, [activeIndex, searchQuery]);

  const copyButton = (
    <button
      onClick={() => void copyTranscript()}
      className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
      title="Copy transcript text"
      aria-label="Copy transcript text"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
    </button>
  );

  // Fallback for unparseable transcripts
  if (blocks.length === 0) {
    return (
      <section className="card overflow-hidden flex flex-col" style={{ maxHeight: "600px" }}>
        <div className="p-6 bg-surface-container-high flex justify-between items-center border-b border-outline-variant/30 flex-shrink-0">
          <h2 className="text-sm font-label uppercase tracking-widest text-primary font-semibold">Transcript</h2>
          {copyButton}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <pre className="whitespace-pre-wrap font-sans text-base leading-relaxed text-on-surface">{text}</pre>
        </div>
      </section>
    );
  }

  return (
    <section
      className="card overflow-hidden flex flex-col"
      style={{ maxHeight: "600px" }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      // React's onFocus/onBlur bubble, so these fire for any descendant —
      // giving the keyboard equivalent of the hover state above.
      onFocus={() => setIsFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsFocusWithin(false);
      }}
    >
      {/* Header with search */}
      <div className="p-6 bg-surface-container-high flex justify-between items-center border-b border-outline-variant/30 flex-shrink-0 gap-3">
        <h2 className="text-sm font-label uppercase tracking-widest text-primary font-semibold">Transcript</h2>
        {searchOpen ? (
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                className="input py-1.5 pl-8 pr-3 text-sm w-48 border-transparent"
                placeholder="Search…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                autoFocus
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </div>
            {searchQuery && (
              <span className="text-xs text-on-surface-variant font-label whitespace-nowrap">
                {allMatches.length > 0 ? `${activeMatch + 1}/${allMatches.length}` : "0/0"}
              </span>
            )}
            <button onClick={goPrev} className="p-1 text-on-surface-variant hover:text-on-surface transition-colors" title="Previous (Shift+Enter)" aria-label="Previous match">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
            </button>
            <button onClick={goNext} className="p-1 text-on-surface-variant hover:text-on-surface transition-colors" title="Next (Enter)" aria-label="Next match">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <button onClick={closeSearch} className="p-1 text-on-surface-variant hover:text-on-surface transition-colors" title="Close (Esc)" aria-label="Close search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {copyButton}
            <button
              onClick={openSearch}
              className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
              title="Search transcript (Ctrl+F)"
              aria-label="Search transcript"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* Transcript body */}
      <div ref={transcriptRef} className="flex-1 overflow-y-auto p-6 space-y-6">
        {blocks.map((block, i) => {
          const isActive = i === activeIndex;
          const color = speakerColor(block.speaker, speakerMap);
          const bm = blockMatchMap.get(i);
          return (
            // A <button>, not a <div onClick>: click-to-seek has to be
            // reachable with Enter/Space and announced as an action, and the
            // browser's own button semantics beat a hand-rolled role/tabIndex.
            <button
              key={i}
              type="button"
              ref={(el) => { if (el) blockRefs.current.set(i, el); }}
              className={`w-full text-left flex gap-6 cursor-pointer group transition-opacity duration-200 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                activeIndex >= 0 && !isActive && !searchQuery ? "opacity-50" : "opacity-100"
              }`}
              onClick={() => onSeek(block.seconds)}
              aria-label={`Play from ${block.timestamp}, ${block.speaker}`}
            >
              {/* spans, not p/div: a <button> may only contain phrasing
                  content, and the layout is all flex/block utilities anyway. */}
              <span className="w-20 shrink-0 text-right">
                <span className="block text-[10px] font-label text-on-surface-variant/60 leading-tight">{block.timestamp}</span>
                <span className="block text-xs font-bold tracking-tight mt-1 uppercase" style={{ color }}>{block.speaker}</span>
              </span>
              <span className="flex-1">
                <span className={`block text-on-surface leading-relaxed text-base ${isActive && !searchQuery ? "font-medium" : ""}`}>
                  {bm ? (
                    <HighlightedText text={block.text} matches={bm.matches} activeMatchIndex={activeMatch} globalOffset={bm.globalOffset} />
                  ) : (
                    block.text
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
