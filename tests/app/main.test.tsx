import { StrictMode, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const bootstrap = vi.hoisted(() => ({ app: (): null => null, correction: (): null => null, createRoot: vi.fn(), label: "main", render: vi.fn() }));
vi.mock("react-dom/client", (): { createRoot: typeof bootstrap.createRoot } => ({ createRoot: bootstrap.createRoot }));
vi.mock("@tauri-apps/api/window", (): { getCurrentWindow: () => { label: string } } => ({ getCurrentWindow: (): { label: string } => ({ label: bootstrap.label }) }));
vi.mock("../../src/App", (): { App: typeof bootstrap.app } => ({ App: bootstrap.app }));
vi.mock("../../src/CorrectionWindow", (): { CorrectionWindow: typeof bootstrap.correction } => ({ CorrectionWindow: bootstrap.correction }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); bootstrap.createRoot.mockReturnValue({ render: bootstrap.render }); document.body.innerHTML = '<div id="root"></div>'; });
afterEach(() => { document.body.innerHTML = ""; });
describe("main bootstrap", () => {
  it.each(["main", "correction-settings", "other"])("routes %s inside StrictMode", async (label) => {
    bootstrap.label = label;
    await import("../../src/main");
    expect(bootstrap.createRoot).toHaveBeenCalledWith(document.querySelector("#root"));
    const candidate: unknown = bootstrap.render.mock.calls[0]?.[0];
    expect(isValidElement(candidate)).toBe(true);
    if (!isValidElement<{ children: ReactNode }>(candidate)) { throw new Error("Expected StrictMode element"); }
    const tree = candidate;
    expect(tree.type).toBe(StrictMode);
    let expectedType = bootstrap.app;
    if (label === "correction-settings") { expectedType = bootstrap.correction; }
    const child = tree.props.children;
    if (!isValidElement(child)) { throw new Error("Expected application element"); }
    expect(child.type).toBe(expectedType);
  }, 15_000);
  it("fails explicitly when the host root is absent", async () => {
    document.body.innerHTML = "";
    await expect(import("../../src/main")).rejects.toThrow("Missing application root");
    expect(bootstrap.createRoot).not.toHaveBeenCalled();
  });
});
