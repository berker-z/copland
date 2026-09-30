// Lunar phase from the clock alone, no API. The phase is the angle between
// the Moon and Sun as seen from Earth (elongation), computed from low-order
// ecliptic-longitude series (Meeus). Counting days from a reference new moon
// is simpler but the Moon's elliptical orbit shifts the quarters by up to
// half a day; the series below lands within a few hours year-round.

const SYNODIC_MONTH_DAYS = 29.530588853;
const MS_PER_DAY = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

export type MoonPhaseName =
  | "new moon"
  | "waxing crescent"
  | "first quarter"
  | "waxing gibbous"
  | "full moon"
  | "waning gibbous"
  | "last quarter"
  | "waning crescent";

export interface MoonPhase {
  /** Approximate days since the last new moon, 0 ≤ age < 29.53. */
  age: number;
  /** Position in the cycle, 0 = new, 0.5 = full, in [0, 1). */
  fraction: number;
  /** Lit portion of the visible disc, 0..1. */
  illumination: number;
  waxing: boolean;
  name: MoonPhaseName;
}

const PHASE_NAMES: MoonPhaseName[] = [
  "new moon",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full moon",
  "waning gibbous",
  "last quarter",
  "waning crescent",
];

const sinDeg = (deg: number) => Math.sin((deg * Math.PI) / 180);
const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

// Geocentric ecliptic longitudes in degrees, d = days since J2000.
const sunLongitude = (d: number) => {
  const L = 280.4665 + 0.98564736 * d;
  const M = 357.5291 + 0.98560028 * d;
  return L + 1.915 * sinDeg(M) + 0.02 * sinDeg(2 * M);
};

const moonLongitude = (d: number) => {
  const L = 218.3165 + 13.17639648 * d; // mean longitude
  const M = 134.9634 + 13.06499295 * d; // mean anomaly
  const Ms = 357.5291 + 0.98560028 * d; // sun's mean anomaly
  const D = 297.8502 + 12.19074912 * d; // mean elongation
  const F = 93.2721 + 13.22935024 * d; // argument of latitude
  return (
    L +
    6.289 * sinDeg(M) +
    1.274 * sinDeg(2 * D - M) +
    0.658 * sinDeg(2 * D) +
    0.214 * sinDeg(2 * M) -
    0.186 * sinDeg(Ms) -
    0.114 * sinDeg(2 * F)
  );
};

export const getMoonPhase = (date: Date = new Date()): MoonPhase => {
  const d = (date.getTime() - J2000_MS) / MS_PER_DAY;
  const elongation = wrap360(moonLongitude(d) - sunLongitude(d));
  const fraction = elongation / 360;
  const illumination = (1 - Math.cos((elongation * Math.PI) / 180)) / 2;
  // Eight buckets centred on the principal phases, so "full moon" spans the
  // ~3.7 days around the instant of opposition rather than a single tick.
  const bucket = Math.floor(fraction * 8 + 0.5) % 8;

  return {
    age: fraction * SYNODIC_MONTH_DAYS,
    fraction,
    illumination,
    waxing: fraction < 0.5,
    name: PHASE_NAMES[bucket],
  };
};
