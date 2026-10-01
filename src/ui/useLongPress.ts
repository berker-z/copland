/* ============================================================================
   Long-press on touch: the phone's stand-in for drag and drop, which HTML5
   drag does not do on a touchscreen.
   ----------------------------------------------------------------------------
   Touch only; a mouse keeps its click and its drag. The press fires after
   PRESS_MS unless the finger moves (that is a scroll) or lifts. The click
   that follows a fired press is swallowed, so the row does not also open.
   ========================================================================== */

import { useRef, type MouseEvent, type PointerEvent } from "react";

const PRESS_MS = 450;
const SLOP_PX = 8;

export function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  const handlers = {
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      if (!onLongPress || event.pointerType !== "touch") return;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        cancel();
        navigator.vibrate?.(10);
        onLongPress();
      }, PRESS_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      if (!start.current) return;
      if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    /* Android opens its own menu on a long press; ours replaces it. */
    onContextMenu: (event: MouseEvent) => {
      if (timer.current !== null || fired.current) event.preventDefault();
    },
  };
  /** Runs before the row's own click: true means swallow it. */
  const swallowClick = () => {
    const was = fired.current;
    fired.current = false;
    return was;
  };
  return { handlers, swallowClick };
}
