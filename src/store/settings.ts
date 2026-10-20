// ── Types ──────────────────────────────────────────────────────────────────

export interface SettingsState {
  [key: string]: string | number | boolean;

  increaseSpeedShortcut: string;
  increaseSpeedStep: number;
  decreaseSpeedShortcut: string;
  decreaseSpeedStep: number;
  resetSpeedShortcut: string;

  gear1Shortcut: string;
  gear1Speed: number;
  gear2Shortcut: string;
  gear2Speed: number;
  gear3Shortcut: string;
  gear3Speed: number;
  gear4Shortcut: string;
  gear4Speed: number;
  gear5Shortcut: string;
  gear5Speed: number;

  holdShortcut: string;
  holdSpeed: number;

  // 组合变速：B(comboShortcut) 按住走 X(comboPressSpeed)、松开走 Y(comboReleaseSpeed)；
  // A(comboSwapShortcut) 按一下把 X 与 Y 互换。
  comboSwapShortcut: string;
  comboShortcut: string;
  comboPressSpeed: number;
  comboReleaseSpeed: number;

  // 快捷键互换：按下 swapShortcut，把 swapSlotA / swapSlotB 这两个槽位上
  // 实际绑定的快捷键对调，并持久写回设置。
  swapShortcut: string;
  swapSlotA: string;
  swapSlotB: string;

  theme: "light" | "dark";
  autoStart: boolean;
  alwaysOnTop: boolean;
  hideToTray: boolean;
  language: "zh-CN" | "zh-TW" | "ja-JP" | "ko-KR" | "de-DE" | "fr-FR" | "en-US" | "ru-RU" | "hi-IN" | "nl-NL" | "pt-BR" | "es-ES";
  speed: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULTS: SettingsState = {
  increaseSpeedShortcut: "",
  increaseSpeedStep: 0.5,
  decreaseSpeedShortcut: "",
  decreaseSpeedStep: 0.5,
  resetSpeedShortcut: "Ctrl+Alt+0",

  gear1Shortcut: "Ctrl+Shift+1",
  gear1Speed: 1.0,
  gear2Shortcut: "Ctrl+Shift+2",
  gear2Speed: 2.0,
  gear3Shortcut: "Ctrl+Shift+3",
  gear3Speed: 5.0,
  gear4Shortcut: "",
  gear4Speed: 10.0,
  gear5Shortcut: "",
  gear5Speed: 100.0,

  holdShortcut: "",
  holdSpeed: 2.0,

  comboSwapShortcut: "",
  comboShortcut: "",
  comboPressSpeed: 2.0,
  comboReleaseSpeed: 1.0,

  swapShortcut: "",
  swapSlotA: "",
  swapSlotB: "",
  theme: "light" as const,
  autoStart: false,
  alwaysOnTop: false,
  // Closing the window tucks the app away in the tray. On by default, which is
  // how the app has always behaved; turn it off to make the close button exit.
  hideToTray: true,
  language: "en-US" as const,
  speed: 1.0,
};

// ── 可互换槽位表 ───────────────────────────────────────────────────────
// swapSlotA/B 存的就是这里的 key。不含 swapShortcut 自己。
export type SwappableSlot = { key: string; labelKey: string; suffix?: string };

export const SWAPPABLE_SLOTS: SwappableSlot[] = [
  { key: "increaseSpeedShortcut", labelKey: "settings.increase" },
  { key: "decreaseSpeedShortcut", labelKey: "settings.decrease" },
  { key: "resetSpeedShortcut", labelKey: "settings.reset" },
  { key: "gear1Shortcut", labelKey: "settings.gear", suffix: "1" },
  { key: "gear2Shortcut", labelKey: "settings.gear", suffix: "2" },
  { key: "gear3Shortcut", labelKey: "settings.gear", suffix: "3" },
  { key: "gear4Shortcut", labelKey: "settings.gear", suffix: "4" },
  { key: "gear5Shortcut", labelKey: "settings.gear", suffix: "5" },
  { key: "holdShortcut", labelKey: "settings.hold" },
  { key: "comboShortcut", labelKey: "settings.combo" },
  { key: "comboSwapShortcut", labelKey: "settings.comboSwap" },
];

// ── Store (singleton) ─────────────────────────────────────────────────────

import { Store } from "@tauri-apps/plugin-store";
import { locale } from "@tauri-apps/plugin-os";
import { mapSystemLocale } from "../i18n";

let _store: Store | null = null;

async function getStore() {
  if (!_store) _store = await Store.load("settings.json");
  return _store;
}

export async function loadSettings(): Promise<SettingsState> {
  const store = await getStore();
  const saved = await store.get<SettingsState>("settings");
  const merged = { ...DEFAULTS, ...saved } as SettingsState;

  // If user has never set a language, use the OS locale
  if (!saved?.language) {
    const sysLocale = await locale();
    merged.language = mapSystemLocale(sysLocale) as SettingsState["language"];
  }

  return merged;
}

export async function getSetting<K extends keyof SettingsState>(key: K): Promise<SettingsState[K]> {
  const store = await getStore();
  const saved = await store.get<SettingsState>("settings");
  const merged = { ...DEFAULTS, ...saved } as SettingsState;

  // If user has never set a language, use the OS locale
  if (!saved?.language) {
    const sysLocale = await locale();
    merged.language = mapSystemLocale(sysLocale) as SettingsState["language"];
  }

  return merged[key];
}

export async function setSetting<K extends keyof SettingsState>(key: K, value: SettingsState[K]) {
  const store = await getStore();
  const saved = (await store.get<SettingsState>("settings")) || ({} as SettingsState);
  saved[key] = value;
  await store.set("settings", saved);
  await store.save();
}
