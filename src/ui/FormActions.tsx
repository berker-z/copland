import type { ReactNode } from "react";

interface FormActionsProps {
  /** The primary button(s), right-aligned after cancel. */
  children: ReactNode;
  onCancel: () => void;
  error?: string | null;
  /** Left-aligned, muted: a keyboard hint and the like. */
  hint?: ReactNode;
}

/**
 * A form modal's last row, inside the body as nord-dash had it: no footer
 * strip under the form, just cancel and the action where the fields end.
 */
export function FormActions({ children, onCancel, error, hint }: FormActionsProps) {
  return (
    <div className="pt-3 flex flex-wrap items-center justify-end gap-3">
      {error ? <span className="text-red text-xs mr-auto">{error}</span> : hint && <span className="text-xs text-faint mr-auto">{hint}</span>}
      <button type="button" onClick={onCancel} className="px-3 py-1.5 pointer-coarse:py-2.5 text-muted hover:text-ink transition-colors">
        cancel
      </button>
      {children}
    </div>
  );
}
