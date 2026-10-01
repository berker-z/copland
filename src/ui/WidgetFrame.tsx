import React from "react";
import { ChevronDown } from "lucide-react";

interface WidgetFrameProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  className?: string;
  bodyClassName?: string;
  bodyStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}

// Splits pane: a flat region on the shared surface. No card chrome — the
// title lives inside a horizontal rule, controls surface on hover, and
// separation from neighbours comes from the 1px divider grid outside.
// A pane with a string title can be collapsed to its header; that is
// remembered per browser (a convenience, not a setting), for the long
// one-column dashboard on a phone.
const storageKey = (title: string) => `copland.collapsed.${title}`;

function readCollapsed(title: string | null): boolean {
  if (!title) return false;
  try {
    return localStorage.getItem(storageKey(title)) === "1";
  } catch {
    return false;
  }
}

function useRemembered(title: string | null) {
  const [collapsed, setCollapsed] = React.useState(() => readCollapsed(title));
  const toggle = title
    ? () =>
        setCollapsed((was) => {
          try {
            if (was) localStorage.removeItem(storageKey(title));
            else localStorage.setItem(storageKey(title), "1");
          } catch {
            /* private mode: collapse for this visit only */
          }
          return !was;
        })
    : undefined;
  return { collapsed, toggle };
}

const baseContainer = "group/pane flex flex-col bg-surface min-h-0";

export const WidgetFrame: React.FC<WidgetFrameProps> = ({
  title,
  subtitle,
  meta,
  icon,
  badge,
  controls,
  children,
  collapsed: collapsedProp,
  onToggleCollapse: onToggleProp,
  className,
  bodyClassName,
  bodyStyle,
  style,
}) => {
  const remembered = useRemembered(typeof title === "string" ? title : null);
  const collapsed = collapsedProp ?? remembered.collapsed;
  const onToggleCollapse = onToggleProp ?? remembered.toggle;

  const containerClasses = className
    ? `${baseContainer} ${className}`
    : baseContainer;
  const contentClasses = bodyClassName
    ? `flex-1 overflow-auto p-4 text-ink ${bodyClassName}`
    : "flex-1 overflow-auto p-4 text-ink";

  return (
    <section className={containerClasses} style={style}>
      <div className={`flex items-center gap-2.5 px-4 pt-3 ${collapsed ? "pb-3" : ""} select-none whitespace-nowrap`}>
        <span className="text-faint" aria-hidden>
          ──
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {icon && <span className="text-muted flex-shrink-0">{icon}</span>}
          <span className="text-lg tracking-[0.14em] text-blue group-hover/pane:text-accent transition-colors truncate">
            {title}
          </span>
          {badge}
        </div>
        {(subtitle || meta) && (
          <span className="text-xs text-muted truncate min-w-0">
            {subtitle}
            {subtitle && meta && <span className="text-faint"> · </span>}
            {meta}
          </span>
        )}
        <span
          className="flex-1 min-w-[1rem] border-t border-faint/50 group-hover/pane:border-accent/40 transition-colors"
          aria-hidden
        />
        <div className="flex items-center gap-1 text-muted pointer-fine:opacity-0 pointer-fine:group-hover/pane:opacity-100 transition-opacity">
          {controls}
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="tap p-1 hover:text-accent transition-colors"
              title={collapsed ? "Expand" : "Collapse"}
            >
              <ChevronDown
                size={14}
                className={collapsed ? "rotate-180 transition-transform" : "transition-transform"}
              />
            </button>
          )}
        </div>
      </div>

      <div className={`${collapsed ? "hidden" : "flex"} flex-1 flex-col min-h-0`}>
        <div className={contentClasses} style={bodyStyle}>
          {children}
        </div>
      </div>
    </section>
  );
};
