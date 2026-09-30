/* ============================================================================
   Theme registry for the Splits design system. A theme is a set of CSS
   variable overrides under [data-theme="<id>"] in styles/themes.css; adding
   one means a block there and an entry here, and no component changes.
   ========================================================================== */

export interface ThemeDef {
  id: string;
  label: string;
}

export const THEMES: ThemeDef[] = [
  { id: "nord", label: "nord" },
  { id: "tokyo-night", label: "tokyo night" },
  { id: "dracula", label: "dracula" },
  { id: "catppuccin", label: "catppuccin" },
  { id: "gruvbox", label: "gruvbox" },
  { id: "one-dark", label: "one dark" },
  { id: "solarized", label: "solarized" },
];
