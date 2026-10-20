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
// 互换键执行完要把所有快捷键按新设置重新注册一遍。init 建好后回填到这里，
// 这样快捷键回调里能拿到最新的 init 而不用在定义时引用自己。
let _rerunInit: (() => Promise<void>) | null = null;

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

  /**
   * 按住变速的唯一实现：按下时记住当前倍率作为基线，松开时恢复它。
   * 之前启动路径和设置里的改键路径各写了一份，改键那份写死回 1.0，
   * 导致在设置里重新绑定就把正确行为覆盖掉。现在两边都走这里。
   */
  const registerHoldRestore = useCallback(async (shortcut: string): Promise<boolean> => {
    let holdBaseline: number | null = null;
    return doRegister(shortcut, ({ state }: ShortcutTriggerState) => {
      if (state === "Pressed") {
        if (holdBaseline === null) holdBaseline = (get("speed") as number) ?? 1.0;
        const hs = (get("holdSpeed") as number) || 2.0;
        invoke("bridge_set_speed", { factor: hs });
        set("speed", hs);
      } else {
        if (holdBaseline === null) return;
        const back = holdBaseline;
        holdBaseline = null;
        invoke("bridge_set_speed", { factor: back });
        set("speed", back);
      }
    });
  }, [doRegister, get, set]);

  /**
   * 快捷键互换的唯一实现：对调 swapSlotA / swapSlotB 两个槽位上实际绑定的
   * 快捷键并落盘，然后按新设置整体重注册一遍。
   * 之前 init() 里写了一份、设置页改键时又用空回调注册了一份，导致在界面里
   * 绑定互换键等于注册了一个什么都不做的处理器。
   */
  const registerSwap = useCallback(async (shortcut: string): Promise<boolean> => {
    return doRegister(shortcut, ({ state }: ShortcutTriggerState) => {
      if (state !== "Pressed") return;
      void (async () => {
        const cur = await getAll();
        const a = cur.swapSlotA as string;
        const b = cur.swapSlotB as string;
        if (!a || !b || a === b) { console.log("[shortcut] swap: 未选或同槽，跳过"); return; }
        const va = (cur as any)[a] as string;
        const vb = (cur as any)[b] as string;
        await set(a as any, vb as any);
        await set(b as any, va as any);
        console.log("[shortcut] swap:", a, "<->", b, va, "<->", vb);
        await _rerunInit?.();
      })();
    });
  }, [doRegister, getAll, set]);

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
      await registerHoldRestore(holdShortcut);
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
    // 快捷键互换：把 swapSlotA / swapSlotB 上实际绑定的快捷键对调并落盘，
    // 然后按新设置整体重注册一遍。只换两边都已绑定的槽位。
    const swapShortcut = s.swapShortcut as string | undefined;
    if (swapShortcut) {
      await registerSwap(swapShortcut);
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

  _rerunInit = init;

  return { register, registerHold, registerHoldRestore, registerSwap, unregister, init, shortcutStatus };
}
