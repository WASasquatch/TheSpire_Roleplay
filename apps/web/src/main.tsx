import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
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
    <App />
  </React.StrictMode>,
);
