import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.js";
import { installAuthFetch } from "./lib/http.js";
import { i18n } from "./lib/i18n.js";
import "./styles.css";

// Wire the session-token interceptor before anything else fires a
// fetch (AuthGate's mount-time /auth/me probe needs to carry the
// header, if a token is already in sessionStorage from a soft reload).
installAuthFetch();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* i18n context for useTranslation throughout the tree. The instance
        itself initializes synchronously on import (en bundled eagerly), so
        mounting the provider adds no async gap before first paint. */}
    <I18nextProvider i18n={i18n}>
      {/* Top-level safety net: a stale-deploy chunk 404 (or any uncaught
          render error) reloads to the fresh build / shows a recovery prompt
          instead of unmounting to a blank page. */}
      <ErrorBoundary
        label="app"
        fallback={(reset) => (
          // Render-prop fallback: hooks are unavailable here, so resolve
          // copy through i18n.t directly — safe even mid-crash because the
          // instance initializes synchronously with en bundled eagerly.
          <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-keep-bg p-8 text-center text-keep-text">
            <p className="font-action text-lg">{i18n.t("errors:somethingWentWrong")}</p>
            <p className="max-w-sm text-sm text-keep-muted">
              {i18n.t("common:errorBoundary.body")}
            </p>
            <button
              type="button"
              onClick={() => { reset(); window.location.reload(); }}
              className="rounded border border-keep-action bg-keep-action/15 px-4 py-1.5 text-xs uppercase tracking-widest text-keep-action"
            >
              {i18n.t("common:errorBoundary.reload")}
            </button>
          </div>
        )}
      >
        <App />
      </ErrorBoundary>
    </I18nextProvider>
  </React.StrictMode>,
);
