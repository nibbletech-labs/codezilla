import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initLogger } from "./lib/logger";
import "./styles/markdownPreview.css";
import "./styles/hljsPreview.css";

initLogger();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
