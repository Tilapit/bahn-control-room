// Where the dataset's cities are, roughly (city centres), so the Monitor can tell
// whether a road disruption lies on an order's way. The records have no map
// positions for cars or drivers; this is only a planning aid for city-to-city legs.

export const CITIES: Record<string, { lat: number; lon: number; country: string }> = {
  Helsinki: { lat: 60.17, lon: 24.94, country: "FI" }, Espoo: { lat: 60.21, lon: 24.66, country: "FI" }, Vantaa: { lat: 60.29, lon: 25.04, country: "FI" },
  Turku: { lat: 60.45, lon: 22.27, country: "FI" }, Tampere: { lat: 61.5, lon: 23.76, country: "FI" }, Lahti: { lat: 60.98, lon: 25.66, country: "FI" },
  Oulu: { lat: 65.01, lon: 25.47, country: "FI" }, Pori: { lat: 61.49, lon: 21.8, country: "FI" }, "Seinäjoki": { lat: 62.79, lon: 22.84, country: "FI" },
  Kotka: { lat: 60.47, lon: 26.95, country: "FI" }, Lappeenranta: { lat: 61.06, lon: 28.19, country: "FI" }, Joensuu: { lat: 62.6, lon: 29.76, country: "FI" },
  Hamburg: { lat: 53.55, lon: 9.99, country: "DE" }, Munich: { lat: 48.14, lon: 11.58, country: "DE" }, Frankfurt: { lat: 50.11, lon: 8.68, country: "DE" },
  Cologne: { lat: 50.94, lon: 6.96, country: "DE" }, Berlin: { lat: 52.52, lon: 13.4, country: "DE" }, Leipzig: { lat: 51.34, lon: 12.37, country: "DE" },
  "Düsseldorf": { lat: 51.23, lon: 6.78, country: "DE" }, Stuttgart: { lat: 48.78, lon: 9.18, country: "DE" }, Hannover: { lat: 52.37, lon: 9.74, country: "DE" },
  Copenhagen: { lat: 55.68, lon: 12.57, country: "DK" }, Odense: { lat: 55.4, lon: 10.39, country: "DK" }, Aarhus: { lat: 56.16, lon: 10.2, country: "DK" },
  Aalborg: { lat: 57.05, lon: 9.92, country: "DK" },
  Stockholm: { lat: 59.33, lon: 18.07, country: "SE" }, Gothenburg: { lat: 57.71, lon: 11.97, country: "SE" }, "Malmö": { lat: 55.6, lon: 13.0, country: "SE" },
  Paris: { lat: 48.86, lon: 2.35, country: "FR" }, Lyon: { lat: 45.76, lon: 4.84, country: "FR" }, Marseille: { lat: 43.3, lon: 5.37, country: "FR" },
  Lille: { lat: 50.63, lon: 3.06, country: "FR" }, Bordeaux: { lat: 44.84, lon: -0.58, country: "FR" },
  Antwerp: { lat: 51.22, lon: 4.4, country: "BE" }, Rotterdam: { lat: 51.92, lon: 4.48, country: "NL" },
  Vienna: { lat: 48.21, lon: 16.37, country: "AT" }, Graz: { lat: 47.07, lon: 15.44, country: "AT" },
}

export function cityAt(name: string | null | undefined) {
  if (!name) return null
  return CITIES[name] ?? CITIES[Object.keys(CITIES).find((city) => name.toLowerCase().startsWith(city.toLowerCase())) ?? ""] ?? null
}

const COUNTRY_ZONE: Record<string, string> = {
  FI: "Europe/Helsinki", DE: "Europe/Berlin", DK: "Europe/Copenhagen", SE: "Europe/Stockholm", FR: "Europe/Paris",
  BE: "Europe/Brussels", NL: "Europe/Amsterdam", AT: "Europe/Vienna",
}

/** The time zone of a dataset city ("Pori" → Europe/Helsinki), so a train in Finland is shown in Finnish time. */
export function zoneOfCity(name: string | null | undefined): string | null {
  const city = cityAt(name)
  return city ? COUNTRY_ZONE[city.country] ?? null : null
}

/** Kilometres from a point to the straight leg between two cities (flat-earth approximation, fine at these distances). */
export function distanceToLegKm(point: { lat: number; lon: number }, a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const kmLat = 111.2
  const kmLon = 111.2 * Math.cos((point.lat * Math.PI) / 180)
  const [px, py] = [point.lon * kmLon, point.lat * kmLat]
  const [ax, ay] = [a.lon * kmLon, a.lat * kmLat]
  const [bx, by] = [b.lon * kmLon, b.lat * kmLat]
  const dx = bx - ax
  const dy = by - ay
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
