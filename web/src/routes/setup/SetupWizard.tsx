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
    <div className="min-h-screen bg-ink-50">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="mb-10 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" />
            applaud setup
          </div>
          <StepIndicator currentIndex={idx} />
        </div>
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

function StepIndicator({ currentIndex }: { currentIndex: number }): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      {STEPS.map((_, i) => (
        <div
          key={i}
          className={`h-1.5 w-8 rounded-full ${
            i <= currentIndex ? "bg-accent" : "bg-ink-200"
          }`}
        />
      ))}
    </div>
  );
}
