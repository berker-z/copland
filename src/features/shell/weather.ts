/* ============================================================================
   Weather for the statusline, and the city search the settings screen uses
   to pick where it is for. Both are Open-Meteo: keyless and CORS open, so
   the browser asks it directly.

   nord-dash fetched the weather once, at page load, and a tab left open all
   day kept showing the morning. This refreshes every REFRESH_MS.
   ========================================================================== */

import { useQuery } from "@tanstack/react-query";
import type { Settings } from "@/domain/settings";

export interface Weather {
  temperature: number;
  /** WMO weather interpretation code. */
  weatherCode: number;
}

/* Open-Meteo's own models update every 15 minutes or slower. */
const REFRESH_MS = 15 * 60_000;

type Place = NonNullable<Settings["location"]>;

async function fetchWeather({ latitude, longitude }: Place): Promise<Weather> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
  const { temperature_2m, weather_code } = json.current ?? {};
  if (typeof temperature_2m !== "number" || typeof weather_code !== "number") throw new Error("No current weather");
  return { temperature: temperature_2m, weatherCode: weather_code };
}

export const useWeather = (place: Place | null) =>
  useQuery({
    queryKey: ["weather", place?.latitude, place?.longitude],
    queryFn: () => fetchWeather(place!),
    enabled: place !== null,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });

/* ----------------------------------------------------------- city search -- */

export interface GeoResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  /** "Istanbul, Türkiye": region and country, for telling Springfields apart. */
  detail: string;
}

export async function searchCities(query: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
  const json = (await res.json()) as {
    results?: { id: number; name: string; latitude: number; longitude: number; admin1?: string; country?: string }[];
  };
  return (json.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    detail: [r.admin1, r.country].filter(Boolean).join(", "),
  }));
}
