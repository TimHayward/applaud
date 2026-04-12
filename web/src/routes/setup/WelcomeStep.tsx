export function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 1</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Welcome to Applaud</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          This tool mirrors your Plaud recordings to local disk and (optionally) fires a
          webhook whenever a new recording or transcript lands. Setup takes about a minute.
        </p>
      </div>
      <div className="space-y-4 text-sm text-on-surface-variant">
        <Bullet>Find your Plaud login automatically from Chrome</Bullet>
        <Bullet>Pick a folder on disk to mirror recordings into</Bullet>
        <Bullet>(Optional) configure a webhook for automations like n8n</Bullet>
        <Bullet>Done — Applaud polls for new recordings every 10 minutes</Bullet>
      </div>
      <div className="flex justify-end pt-4">
        <button className="btn-primary px-8 py-3 flex items-center gap-3 shadow-lg shadow-primary/10" onClick={onNext}>
          Start
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}
