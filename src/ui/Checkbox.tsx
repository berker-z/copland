import React from "react";
import { CheckSquare, Square } from "lucide-react";

interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  size?: number;
  className?: string;
  "aria-label"?: string;
}

// Shared checkbox that matches the todo list aesthetic
export const Checkbox: React.FC<CheckboxProps> = ({
  checked,
  onChange,
  label,
  size = 18,
  className = "",
  "aria-label": ariaLabel,
}) => {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 text-muted transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`}
      aria-label={ariaLabel}
    >
      {checked ? (
        <CheckSquare size={size} className="text-green" />
      ) : (
        <Square size={size} className="text-muted" />
      )}
      {label && <span className="text-ink text-sm">{label}</span>}
    </button>
  );
};
