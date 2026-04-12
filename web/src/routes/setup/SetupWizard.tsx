import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { WelcomeStep } from "./WelcomeStep.js";
import { AuthStep } from "./AuthStep.js";
import { RecordingsDirStep } from "./RecordingsDirStep.js";
import { WebhookStep } from "./WebhookStep.js";
import { ReviewStep } from "./ReviewStep.js";
import { api } from "../../api.js";

const STEPS = ["Welcome", "Auth", "Folder", "Webhook", "Review"] as const;
type Step = (typeof STEPS)[number];

export function SetupWizard(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("Welcome");

  const idx = STEPS.indexOf(step);
  const pct = Math.round(((idx + 1) / STEPS.length) * 100);
  const next = (): void => {
    const n = STEPS[idx + 1];
    if (n) setStep(n);
  };
  const prev = (): void => {
    const p = STEPS[idx - 1];
    if (p) setStep(p);
  };

  const finish = async (): Promise<void> => {
    await api.completeSetup();
    await qc.invalidateQueries({ queryKey: ["setup-status"] });
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-[42rem] px-6 py-12">
        {/* Header */}
        <header className="space-y-6 mb-10">
          <div className="flex items-center justify-between">
            <span className="text-2xl font-black text-on-surface">
              Applaud<span className="text-primary">.</span>
            </span>
            <span className="font-label text-xs uppercase tracking-widest text-on-surface-variant">
              Setup Wizard &bull; {pct}%
            </span>
          </div>
          {/* Progress bars */}
          <div className="grid grid-cols-5 gap-2 h-1.5 w-full">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`rounded-full ${
                  i <= idx ? "bg-primary" : "bg-surface-container-highest"
                }`}
              />
            ))}
          </div>
          {/* Step labels */}
          <div className="hidden md:grid grid-cols-5 gap-2 text-center">
            {STEPS.map((label, i) => (
              <span
                key={label}
                className={`font-label text-[10px] ${
                  i === idx
                    ? "text-primary font-bold"
                    : i < idx
                      ? "text-primary"
                      : "text-on-surface-variant"
                }`}
              >
                {label}
              </span>
            ))}
          </div>
        </header>
        <div className="card p-8">
          {step === "Welcome" && <WelcomeStep onNext={next} />}
          {step === "Auth" && <AuthStep onNext={next} onBack={prev} />}
          {step === "Folder" && <RecordingsDirStep onNext={next} onBack={prev} />}
          {step === "Webhook" && <WebhookStep onNext={next} onBack={prev} />}
          {step === "Review" && <ReviewStep onFinish={finish} onBack={prev} />}
        </div>
      </div>
    </div>
  );
}
