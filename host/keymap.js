// Browser KeyboardEvent.code → Windows virtual-key code, plus "extended key" flag
// (arrows, Home/End, Insert/Delete, right-hand Ctrl/Alt, numpad Enter, … need it).

const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
  AltLeft: 0xa4, AltRight: 0xa5, Pause: 0x13, CapsLock: 0x14, Escape: 0x1b, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  NumLock: 0x90, ScrollLock: 0x91,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf,
  Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
  IntlBackslash: 0xe2
};
for (let i = 0; i < 26; i++) VK['Key' + String.fromCharCode(65 + i)] = 0x41 + i;
for (let i = 0; i <= 9; i++) VK['Digit' + i] = 0x30 + i;
for (let i = 1; i <= 24; i++) VK['F' + i] = 0x6f + i;

const EXTENDED = new Set([
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'ControlRight', 'AltRight', 'NumpadEnter', 'NumpadDivide',
  'MetaLeft', 'MetaRight', 'ContextMenu', 'PrintScreen', 'NumLock'
]);

// Fallbacks when a browser sends no `code` (some mobile keyboards): map by `key`
const BY_KEY = {
  Backspace: 'Backspace', Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft'
};

/**
 * Resolve a browser key event to a Windows key.
 * `metaAs` decides what the Mac ⌘ key becomes: 'ctrl' (default — so ⌘C / ⌘V / ⌘Z copy, paste
 * and undo on Windows like on a Mac) or 'win' (the Windows key).
 */
export function resolveKey(code, key, metaAs = 'ctrl') {
  let c = code && VK[code] !== undefined ? code : (key && BY_KEY[key]) || null;
  if (!c) return null;
  if (metaAs === 'ctrl' && (c === 'MetaLeft' || c === 'MetaRight')) {
    c = c === 'MetaLeft' ? 'ControlLeft' : 'ControlRight';
  }
  return { vk: VK[c], extended: EXTENDED.has(c), code: c };
}

export function isModifierCode(code) {
  return /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code || '');
}
