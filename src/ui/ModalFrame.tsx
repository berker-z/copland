import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ModalTone = "default" | "info" | "danger";
type ModalSize = "sm" | "md" | "lg" | "xl";

interface ModalFrameProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: ModalTone;
  size?: ModalSize;
  children: React.ReactNode;
  onClose?: () => void;
  headerActions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  bodyStyle?: React.CSSProperties;
  hideHeader?: boolean;
  /** Below sm, a bottom sheet as tall as its content instead of the full
      screen: for short menus. */
  fit?: boolean;
}

// Splits modal: a square floating pane. 1px border carries the tone;
// no radius, no blur, no filled header.
const toneStyles: Record<ModalTone, { border: string; accent: string }> = {
  default: {
    border: "border-faint",
    accent: "text-ink",
  },
  info: {
    border: "border-blue/60",
    accent: "text-blue",
  },
  danger: {
    border: "border-red/60",
    accent: "text-red",
  },
};

const sizeClasses: Record<ModalSize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-xl",
  xl: "sm:max-w-3xl",
};

export const ModalFrame: React.FC<ModalFrameProps> = ({
  title,
  subtitle,
  icon,
  tone = "default",
  size = "md",
  children,
  onClose,
  headerActions,
  className,
  bodyClassName,
  bodyStyle,
  hideHeader = false,
  fit = false,
}) => {
  const toneClass = toneStyles[tone];
  /* max-h-full against the wrapper's cap, so a long body scrolls inside the
     frame instead of the frame running past it. */
  const phone = fit ? "border-t" : "h-full";
  const base = `relative bg-surface ${phone} sm:border flex flex-col overflow-hidden sm:h-auto max-h-full ${toneClass.border}`;
  const containerClasses = className ? `${base} ${className}` : base;
  const bodyClasses = bodyClassName
    ? `p-5 text-ink ${bodyClassName}`
    : "p-5 text-ink";

  React.useEffect(() => {
    if (!onClose) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  if (typeof document === "undefined") {
    return null;
  }

  /* A full-screen sheet below sm, where a centred box would leave a sliver
     of backdrop around a cramped form (a bottom sheet with `fit`); the
     floating pane from sm up. */
  const modalContent = (
    <div
      className={`fixed inset-0 z-[60] flex ${fit ? "items-end" : ""} sm:items-center sm:justify-center bg-black/70 sm:p-4`}
      onClick={() => onClose?.()}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div
        className={`w-full ${sizeClasses[size]} ${fit ? "max-h-[85dvh]" : "h-full"} sm:h-auto sm:max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={containerClasses}>
          {!hideHeader && (
            <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-divider">
              <div className="flex items-start gap-3 min-w-0">
                {icon && (
                  <div className={`p-1 ${toneClass.accent}`}>{icon}</div>
                )}
                <div className="min-w-0">
                  <h3
                    className={`text-sm tracking-[0.08em] ${toneClass.accent} truncate`}
                  >
                    {title}
                  </h3>
                  {subtitle && (
                    <p className="text-xs text-muted mt-1 leading-relaxed">
                      {subtitle}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 text-muted">
                {headerActions}
                {onClose && (
                  <button
                    onClick={onClose}
                    className="tap p-2 hover:bg-raised hover:text-yellow transition-colors"
                    title="Close"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className={`flex-1 overflow-auto ${bodyClasses}`} style={bodyStyle}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
