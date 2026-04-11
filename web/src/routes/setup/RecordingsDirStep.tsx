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
    <div>
      <h2 className="text-2xl font-semibold text-ink-900">Recordings folder</h2>
      <p className="mt-2 text-ink-600">
        Where should applaud download your recordings?
      </p>
      <div className="mt-6 space-y-3">
        <label className="block text-sm font-medium text-ink-700">Absolute path</label>
        <div className="flex gap-2">
          <input
            className="input font-mono text-sm"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setResult(null);
            }}
            placeholder="/Users/you/Plaud"
          />
          <button className="btn-secondary" onClick={() => void validate()} disabled={checking}>
            {checking ? "Checking…" : "Check"}
          </button>
        </div>
        <p className="text-xs text-ink-500">
          Relative paths are resolved from the current working directory.
        </p>
      </div>

      {result && (
        <div
          className={`mt-4 rounded-md p-3 text-sm ${
            result.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"
          }`}
        >
          {result.ok ? (
            <div>
              <div>✓ Writable: {result.absolutePath}</div>
              {result.freeBytes && (
                <div className="text-xs">
                  {(result.freeBytes / 1024 ** 3).toFixed(1)} GB free
                </div>
              )}
            </div>
          ) : (
            <div>✗ {result.error ?? "Directory is not usable"}</div>
          )}
        </div>
      )}

      <div className="mt-8 flex justify-between">
        <button className="btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <button className="btn-primary" onClick={() => void save()} disabled={!result?.ok}>
          Next →
        </button>
      </div>
    </div>
  );
}
