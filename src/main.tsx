import "./index.css";
import { App } from "./App";
import { CorrectionWindow } from "./CorrectionWindow";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Missing application root");
}
let content = <App />;
if (getCurrentWindow().label === "correction-settings") {
  content = <CorrectionWindow />;
}
createRoot(root).render(<StrictMode>{content}</StrictMode>);
