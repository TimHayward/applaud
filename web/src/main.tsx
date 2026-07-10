import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { ThemeContext, useThemeProvider } from "./hooks/useTheme.js";
import { setLanToken } from "./api.js";
import { ToastProvider } from "./components/Toast.js";
import { ConfirmProvider } from "./components/ConfirmDialog.js";
import "./index.css";

// Capture a `?token=` from a shared LAN link (see Settings → LAN access),
// persist it for future requests, then scrub it from the visible URL.
{
  const params = new URLSearchParams(window.location.search);
  const incomingToken = params.get("token");
  if (incomingToken) {
    setLanToken(incomingToken);
    params.delete("token");
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", cleanUrl);
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

function Root(): JSX.Element {
  const themeValue = useThemeProvider();
  return (
    <ThemeContext.Provider value={themeValue}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
