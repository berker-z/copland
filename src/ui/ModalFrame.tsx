import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ModalTone = "default" | "info" | "danger";
type ModalSize = "sm" | "md" | "lg";

interface ModalFrameProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: ModalTone;
  size?: ModalSize;
  children: React.ReactNode;
  onClose?: () => void;
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  bodyStyle?: React.CSSProperties;
  hideHeader?: boolean;
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
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-xl",
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
  footer,
  className,
  bodyClassName,
  bodyStyle,
  hideHeader = false,
}) => {
  const toneClass = toneStyles[tone];
  const containerClasses = className
    ? `relative bg-surface border flex flex-col overflow-hidden ${toneClass.border} ${className}`
    : `relative bg-surface border flex flex-col overflow-hidden ${toneClass.border}`;
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

  const modalContent = (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={() => onClose?.()}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div
        className={`w-full ${sizeClasses[size]} max-h-[90vh]`}
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
                    className="p-2 hover:bg-raised hover:text-yellow transition-colors"
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

          {footer && (
            <div className="border-t border-divider bg-bar/60 px-5 py-3 flex items-center justify-end gap-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
