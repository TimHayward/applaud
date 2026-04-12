import { useState } from "react";
import { api } from "../../api.js";

export function RecordingsDirStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const [value, setValue] = useState("./recordings");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<null | {
    ok: boolean;
    absolutePath?: string;
    freeBytes?: number;
    error?: string;
  }>(null);

  const validate = async (): Promise<void> => {
    setChecking(true);
    setResult(null);
    try {
      const r = await api.validateRecordingsDir(value);
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!result?.ok || !result.absolutePath) return;
    await api.updateConfig({ recordingsDir: result.absolutePath });
    onNext();
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 3</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Recordings Folder</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Where should Applaud download your recordings?
        </p>
      </div>

      <div className="space-y-4">
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">Directory Path</label>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary/60">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <input
              className="w-full bg-surface-container-highest/50 border-0 rounded-lg py-4 pl-12 pr-4 font-mono text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:ring-2 focus:ring-primary/40 focus:outline-none"
              value={value}
              onChange={(e) => { setValue(e.target.value); setResult(null); }}
              placeholder="/Users/you/Plaud"
            />
          </div>
          <button className="btn-primary px-6 py-4" onClick={() => void validate()} disabled={checking}>
            {checking ? "Checking…" : "Check"}
          </button>
        </div>

        {/* Info box */}
        <div className="bg-surface-container-highest/30 p-4 rounded-lg flex items-start gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-secondary mt-0.5 flex-shrink-0">
            <circle cx="12" cy="12" r="10" opacity="0.2" /><circle cx="12" cy="12" r="4" />
          </svg>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            Relative paths are resolved from the current working directory. Use an absolute path for reliability.
          </p>
        </div>
      </div>

      {result && (
        <div className={`rounded-lg p-4 flex items-center gap-3 ${
          result.ok ? "bg-secondary/10 border border-secondary/20" : "bg-error/10 border border-error/20"
        }`}>
          {result.ok ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-secondary flex-shrink-0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-error flex-shrink-0"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
          )}
          <div>
            <p className={`font-bold text-sm ${result.ok ? "text-secondary" : "text-error"}`}>
              {result.ok ? "Directory Valid" : "Directory Invalid"}
            </p>
            <p className={`text-xs ${result.ok ? "text-secondary/70" : "text-error/70"}`}>
              {result.ok ? `${result.absolutePath}${result.freeBytes ? ` — ${(result.freeBytes / 1024 ** 3).toFixed(1)} GB free` : ""}` : result.error ?? "Directory is not usable"}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-4">
        <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Back
        </button>
        <button className="btn-primary px-8 py-3 flex items-center gap-3 shadow-lg shadow-primary/10" onClick={() => void save()} disabled={!result?.ok}>
          Next
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}
