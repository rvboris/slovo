const EMPTY_LENGTH = 0;
const SINGLE_KEY_LENGTH = 1;
const modifierOrder = ["Ctrl", "Alt", "Shift", "Super"] as const;
const modifierKeys: Readonly<Partial<Record<string, (typeof modifierOrder)[number]>>> = {
  Alt: "Alt",
  Control: "Ctrl",
  Meta: "Super",
  Shift: "Shift",
};

function displayKey(key: string): string {
  const names: Readonly<Partial<Record<string, string>>> = {
    " ": "Space",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    Backquote: "Ё / `",
    Backspace: "Backspace",
    Delete: "Delete",
    Enter: "Enter",
    Escape: "Esc",
    Spacebar: "Space",
    Tab: "Tab",
  };

  if (names[key] !== undefined) {
    return names[key];
  }
  if (/^Key[A-Z]$/u.test(key)) {
    return key.slice("Key".length);
  }
  if (/^Digit[0-9]$/u.test(key)) {
    return key.slice("Digit".length);
  }
  if (key.length === SINGLE_KEY_LENGTH) {
    return key.toUpperCase();
  }
  return key;
}

function hotkeyCode(
  event: Readonly<
    Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  >,
): string | null {
  if (/^(?:Key[A-Z]|Digit[0-9])$/u.test(event.code)) {
    return event.code;
  }
  if (event.code !== "" && event.code !== "Unidentified") {
    return event.code;
  }
  return null;
}

function isSupportedHotkeyCode(code: string): boolean {
  return (
    /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(code) ||
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

function formatHotkey(
  event: Readonly<
    Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  >,
): string | null {
  if (modifierKeys[event.key] !== undefined) {
    return null;
  }
  const key = hotkeyCode(event);
  if (key === null || !isSupportedHotkeyCode(key)) {
    return null;
  }

  const modifiers = modifierOrder.filter((modifier) => {
    if (modifier === "Ctrl") {
      return event.ctrlKey;
    }
    if (modifier === "Alt") {
      return event.altKey;
    }
    if (modifier === "Shift") {
      return event.shiftKey;
    }
    return event.metaKey;
  });

  if (modifiers.length === EMPTY_LENGTH) {
    return null;
  }
  return [...modifiers, key].join("+");
}

function isModifierKey(key: string): boolean {
  return key in modifierKeys;
}

function hotkeyParts(value: string): string[] {
  return value.split("+").filter(Boolean);
}

function displayPart(part: string): string {
  if (part === "Meta" || part === "Super") {
    if (navigator.platform.includes("Mac")) {
      return "⌘";
    }
    return "Super";
  }
  return displayKey(part);
}

export { displayKey, displayPart, formatHotkey, hotkeyParts, isModifierKey };
