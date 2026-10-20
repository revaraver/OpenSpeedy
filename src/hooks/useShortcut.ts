import { useCallback } from "react";
import { useSyncExternalStore } from "react";
import * as GlobalShortcut from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "./useSettings";

type ShortcutTriggerState = {
  id: number;
  shortcut: string;
  state: "Pressed" | "Released";
};

// ── Module-level store (useSyncExternalStore compatible) ────────────────────

let _statusCache: Record<string, boolean> = {};
const _statusListeners = new Set<() => void>();

// 组合变速的翻转状态：A 键按一下取反一次。放在模块级，这样改设置重新注册
// 快捷键时不会把已经翻转的状态清掉。
let _comboSwapped = false;
export function isComboSwapped(): boolean { return _comboSwapped; }
export function toggleComboSwap(): boolean {
  _comboSwapped = !_comboSwapped;
  console.log("[shortcut] combo swap ->", _comboSwapped ? "X/Y 已互换" : "X/Y 已还原");
  return _comboSwapped;
}

function subscribe(callback: () => void) {
  _statusListeners.add(callback);
  return () => { _statusListeners.delete(callback); };
}

function getSnapshot(): Record<string, boolean> {
  return _statusCache;
}

function emit() {
  _statusListeners.forEach(fn => fn());
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useShortcut() {
  const { getAll, get, set } = useSettings();
  const shortcutStatus = useSyncExternalStore(subscribe, getSnapshot);

  const doRegister = useCallback(async (
    shortcut: string,
    handler: (s: ShortcutTriggerState) => void,
  ): Promise<boolean> => {
    if (!shortcut) return false;
    try {
      await GlobalShortcut.register(shortcut, handler);
      _statusCache = { ..._statusCache, [shortcut]: true };
      emit();
      console.log("[shortcut] register OK:", shortcut);
      return true;
    } catch (e) {
      console.error("[shortcut] register FAIL:", shortcut, e);
      _statusCache = { ..._statusCache, [shortcut]: false };
      emit();
      return false;
    }
  }, []);

  const register = useCallback(async (shortcut: string, callback: () => void): Promise<boolean> => {
    return doRegister(shortcut, ({ state }: ShortcutTriggerState) => {
      if (state !== "Pressed") return;
      callback();
    });
  }, [doRegister]);

  const registerHold = useCallback(async (
    shortcut: string,
    onPress: () => void,
    onRelease: () => void,
  ): Promise<boolean> => {
    return doRegister(shortcut, ({ state }: ShortcutTriggerState) => {
      if (state === "Pressed") onPress();
      else onRelease();
    });
  }, [doRegister]);

  const unregister = useCallback(async (shortcut: string) => {
    if (!shortcut) return;
    if (await GlobalShortcut.isRegistered(shortcut)) await GlobalShortcut.unregister(shortcut);
    const { [shortcut]: _, ...rest } = _statusCache;
    _statusCache = rest;
    emit();
  }, []);

  const init = useCallback(async () => {
    await GlobalShortcut.unregisterAll().catch(() => {});
    const s = await getAll();

    const reg = register;
    await reg(s.increaseSpeedShortcut as string, () => {
      invoke<number | null>("bridge_get_speed").then(current => {
        const next = (current ?? 1) + ((get("increaseSpeedStep") as number) || 0.5);
        invoke("bridge_set_speed", { factor: next });
        set("speed", next);
      });
    });
    await reg(s.decreaseSpeedShortcut as string, () => {
      invoke<number | null>("bridge_get_speed").then(current => {
        const next = Math.max(0.01, (current ?? 1) - ((get("decreaseSpeedStep") as number) || 0.5));
        invoke("bridge_set_speed", { factor: next });
        set("speed", next);
      });
    });
    await reg(s.resetSpeedShortcut as string, () => {
      invoke("bridge_set_speed", { factor: 1.0 });
      set("speed", 1.0);
    });
    for (let i = 1; i <= 5; i++) {
      const shortcut = s[`gear${i}Shortcut` as keyof typeof s] as string | undefined;
      if (shortcut) await reg(shortcut, () => {
        const speed = (get(`gear${i}Speed` as keyof typeof s) as number) || 1;
        invoke("bridge_set_speed", { factor: speed });
        set("speed", speed);
      });
    }

    // Hold shortcut: press → target speed, release → restore the speed that
    // was active before the press (not a hardcoded 1.0). The baseline is
    // captured on the first press and kept until a release consumes it, so a
    // missed Release event cannot clobber it with the hold speed itself.
    const holdShortcut = s.holdShortcut as string | undefined;
    if (holdShortcut) {
      let holdBaseline: number | null = null;
      await registerHold(holdShortcut, () => {
        if (holdBaseline === null) holdBaseline = (get("speed") as number) ?? 1.0;
        const hs = (get("holdSpeed") as number) || 2.0;
        invoke("bridge_set_speed", { factor: hs });
        set("speed", hs);
      }, () => {
        if (holdBaseline === null) return;
        const back = holdBaseline;
        holdBaseline = null;
        invoke("bridge_set_speed", { factor: back });
        set("speed", back);
      });
    }
    // 组合变速：B 按住 → X 速，松开 → Y 速；A 按一下把 X 与 Y 互换。
    // 注意松开走的是配置死的 Y，不是"恢复按下前的速度"——那是 holdShortcut 的行为。
    const comboShortcut = s.comboShortcut as string | undefined;
    if (comboShortcut) {
      await registerHold(comboShortcut, () => {
        const x = (get("comboPressSpeed" as keyof typeof s) as number) || 2.0;
        const y = (get("comboReleaseSpeed" as keyof typeof s) as number) || 1.0;
        const v = _comboSwapped ? y : x;
        invoke("bridge_set_speed", { factor: v });
        set("speed", v);
      }, () => {
        const x = (get("comboPressSpeed" as keyof typeof s) as number) || 2.0;
        const y = (get("comboReleaseSpeed" as keyof typeof s) as number) || 1.0;
        const v = _comboSwapped ? x : y;
        invoke("bridge_set_speed", { factor: v });
        set("speed", v);
      });
    }
    const comboSwapShortcut = s.comboSwapShortcut as string | undefined;
    if (comboSwapShortcut) {
      await reg(comboSwapShortcut, () => {
        const swapped = toggleComboSwap();
        // 翻转之后"松开时"那一挡变成 swapped ? X : Y。A 顺手把当前倍率直接
        // 设成它，翻完状态就自洽，不用等一次按放才切过去。
        const x = (get("comboPressSpeed" as keyof typeof s) as number) || 2.0;
        const y = (get("comboReleaseSpeed" as keyof typeof s) as number) || 1.0;
        const release = swapped ? x : y;
        invoke("bridge_set_speed", { factor: release });
        set("speed", release);
      });
    }
  }, [register, registerHold, set, getAll, get]);

  return { register, registerHold, unregister, init, shortcutStatus };
}
