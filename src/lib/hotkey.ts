const modifierOrder = ["Ctrl", "Alt", "Shift", "Super"] as const;
const modifierKeys: Record<string, (typeof modifierOrder)[number]> = {
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Super",
};

export function displayKey(key: string): string {
  const names: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Tab: "Tab",
    Backquote: "Ё / `",
  };

  if (names[key]) return names[key];
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit[0-9]$/.test(key)) return key.slice(5);
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function hotkeyCode(event: KeyboardEvent): string | null {
  if (/^(Key[A-Z]|Digit[0-9])$/.test(event.code)) return event.code;
  if (event.code && event.code !== "Unidentified") return event.code;
  return null;
}

function isSupportedHotkeyCode(code: string): boolean {
  return (
    /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(code) ||
    [
      "Backquote",
      "Backslash",
      "BracketLeft",
      "BracketRight",
      "Comma",
      "Equal",
      "Minus",
      "Period",
      "Quote",
      "Semicolon",
      "Slash",
      "Backspace",
      "Delete",
      "End",
      "Enter",
      "Home",
      "Insert",
      "PageDown",
      "PageUp",
      "Space",
      "Tab",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
    ].includes(code)
  );
}

export function formatHotkey(event: KeyboardEvent): string | null {
  if (modifierKeys[event.key]) return null;
  const key = hotkeyCode(event);
  if (!key || !isSupportedHotkeyCode(key)) return null;

  const modifiers = modifierOrder.filter((modifier) => {
    if (modifier === "Ctrl") return event.ctrlKey;
    if (modifier === "Alt") return event.altKey;
    if (modifier === "Shift") return event.shiftKey;
    return event.metaKey;
  });

  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}

export function isModifierKey(key: string): boolean {
  return key in modifierKeys;
}

export function hotkeyParts(value: string): string[] {
  return value.split("+").filter(Boolean);
}

export function displayPart(part: string): string {
  if (part === "Meta" || part === "Super") {
    return navigator.platform.includes("Mac") ? "⌘" : "Super";
  }
  return displayKey(part);
}
