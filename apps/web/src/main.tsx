import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { installAuthFetch } from "./lib/http.js";
import "./styles.css";

// Wire the session-token interceptor before anything else fires a
// fetch (AuthGate's mount-time /auth/me probe needs to carry the
// header, if a token is already in sessionStorage from a soft reload).
installAuthFetch();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* Top-level safety net: a stale-deploy chunk 404 (or any uncaught
        render error) reloads to the fresh build / shows a recovery prompt
        instead of unmounting to a blank page. */}
    <ErrorBoundary
      label="app"
      fallback={(reset) => (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-keep-bg p-8 text-center text-keep-text">
          <p className="font-action text-lg">Something went wrong</p>
          <p className="max-w-sm text-sm text-keep-muted">
            The app hit an unexpected error. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => { reset(); window.location.reload(); }}
            className="rounded border border-keep-action bg-keep-action/15 px-4 py-1.5 text-xs uppercase tracking-widest text-keep-action"
          >
            Reload
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
