/* ============================================================================
   Writing settings: optimistic, so a theme switch or a coin added shows at
   once and the server catches up. On failure the cache is put back and the
   server's copy refetched.

   The theme is also mirrored to localStorage, only so the first paint of the
   next page load is in the right colours before /api/settings answers. The
   server copy is the truth; localStorage failing (private mode, blocked
   storage) changes nothing but that first paint.
   ========================================================================== */

import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_SETTINGS, type Settings } from "@/domain/settings";
import { THEMES } from "@/domain/themes";
import { send } from "./api";
import { KEYS, useSettings } from "./queries";

const THEME_CACHE = "copland_theme";

export function cachedTheme(): string {
  try {
    const saved = localStorage.getItem(THEME_CACHE);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SETTINGS.theme;
}

/** Keep <html data-theme> in step with the user's setting. */
export function useApplyTheme(enabled: boolean): void {
  const { data } = useSettings(enabled);
  const theme = data?.theme ?? cachedTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_CACHE, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => send<Settings>("PATCH", "/settings", patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: KEYS.settings });
      const previous = queryClient.getQueryData<Settings>(KEYS.settings);
      queryClient.setQueryData<Settings>(KEYS.settings, { ...(previous ?? DEFAULT_SETTINGS), ...patch });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.settings, context.previous);
    },
    onSuccess: (settings) => queryClient.setQueryData(KEYS.settings, settings),
  });
}
