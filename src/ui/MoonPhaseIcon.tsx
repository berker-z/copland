import React from "react";
import type { MoonPhase } from "@/domain/moon";

interface MoonPhaseIconProps {
  phase: MoonPhase;
  size?: number;
  /** Southern hemisphere sees the lit side mirrored. */
  hemisphere?: "north" | "south";
  className?: string;
}

// Draws the real terminator instead of picking from eight fixed icons: the
// lit region is bounded by the limb on one side and a half-ellipse whose
// x-radius is |cos(phase angle)| on the other, so it sweeps crescent → half
// → gibbous continuously. Lit fill uses currentColor; the dark disc is the
// bar surface with a faint outline so a new moon still reads as a disc.
export const MoonPhaseIcon: React.FC<MoonPhaseIconProps> = ({
  phase,
  size = 16,
  hemisphere = "north",
  className,
}) => {
  const c = 12;
  const r = 10;
  const litOnRight = hemisphere === "north" ? phase.waxing : !phase.waxing;
  const crescent = phase.illumination < 0.5;
  const rx = r * Math.abs(Math.cos(2 * Math.PI * phase.fraction));

  // Limb arc top→bottom around the lit side, then back up along the
  // terminator. Sweep flags: 1 is clockwise in SVG's y-down space.
  const limbSweep = litOnRight ? 1 : 0;
  // A crescent's terminator bulges toward the lit side, a gibbous one away.
  const terminatorSweep = litOnRight === crescent ? 0 : 1;
  const lit = [
    `M ${c} ${c - r}`,
    `A ${r} ${r} 0 0 ${limbSweep} ${c} ${c + r}`,
    `A ${rx} ${r} 0 0 ${terminatorSweep} ${c} ${c - r}`,
    "Z",
  ].join(" ");

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden
    >
      <circle cx={c} cy={c} r={r} className="fill-bar stroke-faint" strokeWidth={1} />
      <path d={lit} fill="currentColor" />
    </svg>
  );
};
