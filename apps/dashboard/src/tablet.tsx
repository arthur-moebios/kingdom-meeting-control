import React from "react";
import ReactDOM from "react-dom/client";
import { TabletView } from "./TabletView.js";
import { setToken } from "./api.js";
import "./tablet.css";

// Kiosk convenience: a one-time ?token=<viewer-token> in the URL is stored and
// stripped (so the token is not left in the address bar / history).
try {
  const params = new URLSearchParams(location.search);
  const t = params.get("token");
  if (t) {
    setToken(t);
    history.replaceState(null, "", location.pathname);
  }
} catch {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TabletView />
  </React.StrictMode>,
);
