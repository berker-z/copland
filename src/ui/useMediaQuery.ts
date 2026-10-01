import { useSyncExternalStore } from "react";

/** Whether a media query matches now, re-rendering when that changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** A touchscreen: size by this, lay out by width (docs/DESIGN.md, Touch). */
export const useTouch = () => useMediaQuery("(pointer: coarse)");
/** Below Tailwind's sm. */
export const usePhone = () => useMediaQuery("(max-width: 639.98px)");
