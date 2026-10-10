import {
  displayKey,
  displayPart,
  formatHotkey,
  hotkeyParts,
  isModifierKey,
} from "../../src/lib/hotkey";
// oxlint-disable-next-line sort-imports -- grouped named imports keep helper source order readable
import {
  DEFAULT_SETTINGS,
  formatElapsed,
  getErrorMessage,
  normalizeSettings,
  normalizeTriggerType,
} from "../../src/lib/types";
import { describe, expect, it } from "vitest";
import { cn } from "../../src/lib/utils";

describe("hotkey helpers", () => {
  it.each([
    ["KeyA", "A"],
    ["Digit9", "9"],
    ["Escape", "Esc"],
    ["ArrowLeft", "←"],
    ["Backquote", "Ё / `"],
    [" ", "Space"],
    ["я", "Я"],
    ["Unknown", "Unknown"],
  ])("displays %s as %s", (key, expected) => {
    expect(displayKey(key)).toBe(expected);
  });
  it("formats physical codes in canonical modifier order independently of keyboard language", () => {
    expect(
      formatHotkey(
        new KeyboardEvent("keydown", {
          altKey: true,
          code: "KeyA",
          ctrlKey: true,
          key: "ф",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe("Ctrl+Alt+Shift+Super+KeyA");
    expect(
      formatHotkey(new KeyboardEvent("keydown", { code: "F24", ctrlKey: true, key: "F24" })),
    ).toBe("Ctrl+F24");
  });
  it.each([
    { code: "ControlLeft", ctrlKey: true, key: "Control" },
    { code: "KeyA", key: "a" },
    { code: "Unidentified", ctrlKey: true, key: "a" },
    { code: "AudioVolumeUp", ctrlKey: true, key: "AudioVolumeUp" },
  ])("rejects unsupported or unmodified input %#", (event) => {
    expect(formatHotkey(new KeyboardEvent("keydown", event))).toBeNull();
  });
  it("splits chords and identifies modifiers and display labels", () => {
    expect(hotkeyParts("Ctrl++KeyA+")).toEqual(["Ctrl", "KeyA"]);
    expect(isModifierKey("Control")).toBe(true);
    expect(isModifierKey("KeyA")).toBe(false);
    expect(displayPart("KeyA")).toBe("A");
    expect(["⌘", "Super"]).toContain(displayPart("Meta"));
  });
});
describe("settings and messages", () => {
  it("accepts legacy settings, defaults correction fields, and preserves nullable input selection", () => {
    expect(
      normalizeSettings({ input_device: "Mic", server_url: " http://host ", trigger_type: "hold" }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      inputDevice: "Mic",
      serverUrl: "http://host",
      triggerType: "hold",
    });
    expect(normalizeSettings(null)).toEqual({ ...DEFAULT_SETTINGS, serverUrl: "" });
    expect(
      normalizeSettings({
        hotkey: "   ",
        llmApiKey: "key",
        llmModel: "model",
        llmPrompt: "prompt",
        llmServerUrl: "https://host",
      }),
    ).toMatchObject({
      hotkey: DEFAULT_SETTINGS.hotkey,
      llmApiKey: "key",
      llmModel: "model",
      llmPrompt: "prompt",
      llmServerUrl: "https://host",
    });
  });
  it.each([
    ["hold", "hold"],
    ["auto-vad", "auto-vad"],
    ["toggle", "toggle"],
    ["unknown", "toggle"],
  ])("normalizes trigger %s", (input, output) => {
    expect(normalizeTriggerType(input)).toBe(output);
  });
  it("selects meaningful errors and formats elapsed time", () => {
    expect(getErrorMessage("server failed", "fallback")).toBe("server failed");
    expect(getErrorMessage(new Error("error"), "fallback")).toBe("error");
    expect(getErrorMessage(" ", "fallback")).toBe("fallback");
    expect(getErrorMessage({}, "fallback")).toBe("fallback"); // oxlint-disable-next-line unicorn(error-message) -- empty-message fallback is the behavior under test
    const emptyError = Reflect.construct(Error, [""]);
    expect(getErrorMessage(emptyError, "fallback")).toBe("fallback");
    expect(formatElapsed()).toBe("00:00");
    expect(formatElapsed(65.9)).toBe("01:05");
    expect(formatElapsed(3600)).toBe("60:00");
  });
  it("merges conditional class names and resolves Tailwind conflicts", () => {
    expect(cn("px-2", false, ["text-sm", { hidden: false }], "px-4")).toBe("text-sm px-4");
  });
});
