import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api.js";
import { SetupWizard } from "./routes/setup/SetupWizard.js";
import { Dashboard } from "./routes/Dashboard.js";
import { RecordingDetailPage } from "./routes/RecordingDetail.js";
import { Settings } from "./routes/Settings.js";
import { AppShell } from "./components/AppShell.js";

export function App(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const setupStatus = useQuery({
    queryKey: ["setup-status"],
    queryFn: api.setupStatus,
    refetchInterval: location.pathname.startsWith("/setup") ? 3_000 : false,
  });

  useEffect(() => {
    if (!setupStatus.data) return;
    const onSetup = location.pathname.startsWith("/setup");
    if (!setupStatus.data.setupComplete && !onSetup) {
      navigate("/setup", { replace: true });
    }
    if (setupStatus.data.setupComplete && onSetup) {
      navigate("/", { replace: true });
    }
  }, [setupStatus.data, location.pathname, navigate]);

  if (setupStatus.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-500">
        loading…
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/setup/*" element={<SetupWizard />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/recordings/:id" element={<RecordingDetailPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
