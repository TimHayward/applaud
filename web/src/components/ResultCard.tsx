/** Generic success/failure result card (webhook tests, directory validation, …). */
export function ResultCard({
  ok,
  title,
  detail,
}: {
  ok: boolean;
  title: string;
  detail?: string;
}): JSX.Element {
  return (
    <div
      className={`rounded-lg p-4 flex items-center gap-3 ${
        ok ? "bg-secondary/10 border border-secondary/20" : "bg-error/10 border border-error/20"
      }`}
    >
      {ok ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-secondary flex-shrink-0">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-error flex-shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      )}
      <div>
        <p className={`font-bold text-sm ${ok ? "text-secondary" : "text-error"}`}>{title}</p>
        {detail ? <p className={`text-xs break-all ${ok ? "text-secondary/70" : "text-error/70"}`}>{detail}</p> : null}
      </div>
    </div>
  );
}
