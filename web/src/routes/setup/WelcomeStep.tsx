export function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Welcome to applaud</h1>
      <p className="mt-3 text-ink-600">
        This tool mirrors your Plaud recordings to local disk and (optionally) fires a
        webhook whenever a new recording or transcript lands. Setup takes about a minute.
      </p>
      <div className="mt-6 space-y-3 text-sm text-ink-600">
        <Bullet>Find your Plaud login automatically from Chrome</Bullet>
        <Bullet>Pick a folder on disk to mirror recordings into</Bullet>
        <Bullet>(Optional) configure a webhook for automations like n8n</Bullet>
        <Bullet>Done — applaud polls for new recordings every 10 minutes</Bullet>
      </div>
      <div className="mt-10 flex justify-end">
        <button className="btn-primary" onClick={onNext}>
          Start →
        </button>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
      <span>{children}</span>
    </div>
  );
}
