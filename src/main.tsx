import "./index.css";
import { App } from "./App";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Missing application root");
}
createRoot(root).render(<StrictMode><App /></StrictMode>);
