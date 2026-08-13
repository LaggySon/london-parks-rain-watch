import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TRIP_START = "2026-08-28";
const LATITUDE = 51.5074;
const LONGITUDE = -0.1278;
const TIMEOUT_MS = 8000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const weights = { met: .35, time: .20, network: .15, weather25: .10, ecmwf: .20 };

const baseline = {
  met: { label: "Met Office (UKMO)", amount: 8, probability: 55, url: "https://weather.metoffice.gov.uk/long-range-forecast" },
  time: { label: "Timeanddate", amount: 15.2, probability: 75, url: "https://www.timeanddate.com/weather/uk/london/ext" },
  network: { label: "Weather Network", amount: 34.5, probability: 90, url: "https://www.theweathernetwork.com/en/city/gb/greater-london/london/14-days" },
  weather25: { label: "Weather25", amount: 10.6, probability: 65, url: "https://www.weather25.com/europe/united-kingdom/london?page=day" },
  ecmwf: { label: "ECMWF IFS", amount: 3, probability: 20, url: "https://open-meteo.com/en/docs/ecmwf-api" },
};

type Key = keyof typeof baseline;
type Day = { key: string; mm: number; pop: number | null };
type Source = typeof baseline[Key] & {
  amount: number;
  probability: number;
  status: "live" | "baseline";
  days: number;
  reason?: string;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Days from today (Europe/London) up to, but not including, the trip start. */
function forecastWindow() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const end = new Date(`${TRIP_START}T00:00:00Z`).getTime();
  const dates: string[] = [];
  for (let t = new Date(`${today}T00:00:00Z`).getTime(); t < end && dates.length < 30; t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return { dates, monthDays: new Set(dates.map(date => date.slice(5))) };
}

function monthDayKey(month: string, day: string) {
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (index < 0) return null;
  return `${String(index + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function plain(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&deg;/g, "°").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

async function getText(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-GB,en;q=0.9" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return plain(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Falls back to the app's own amount/probability relationship when a source
 * publishes rainfall but no probability of precipitation.
 */
function impliedProbability(amount: number) {
  return Math.max(5, Math.min(95, 12 + amount * 4.3));
}

function summarise(key: Key, days: Day[], monthDays: Set<string>): Source {
  const inWindow = days.filter(day => monthDays.has(day.key));
  if (!inWindow.length) throw new Error("no forecast days inside the window");
  const amount = inWindow.reduce((total, day) => total + day.mm, 0);
  const pops = inWindow.map(day => day.pop).filter((pop): pop is number => pop != null);
  const probability = pops.length ? Math.max(...pops) : impliedProbability(amount);
  return {
    ...baseline[key],
    amount: Number(amount.toFixed(1)),
    probability: Number(probability.toFixed(0)),
    status: "live",
    days: inWindow.length,
  };
}

/** Met Office UKMO and ECMWF IFS daily fields, both from Open-Meteo's model endpoint. */
async function fetchOpenMeteo(monthDays: Set<string>) {
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${LATITUDE}&longitude=${LONGITUDE}`
    + "&daily=precipitation_sum,precipitation_probability_max"
    + "&timezone=Europe%2FLondon&forecast_days=16"
    + "&models=ukmo_seamless,ecmwf_ifs025";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let payload: any;
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } finally {
    clearTimeout(timer);
  }

  const read = (key: Key, model: string): Source => {
    const time: string[] = payload?.daily?.time ?? [];
    const sums: (number | null)[] = payload?.daily?.[`precipitation_sum_${model}`] ?? [];
    const pops: (number | null)[] = payload?.daily?.[`precipitation_probability_max_${model}`] ?? [];
    const days: Day[] = time
      .map((date, index) => ({ key: date.slice(5), mm: sums[index] ?? null, pop: pops[index] ?? null }))
      .filter((day): day is Day => day.mm != null);
    return summarise(key, days, monthDays);
  };

  return { met: read("met", "ukmo_seamless"), ecmwf: read("ecmwf", "ecmwf_ifs025") };
}

/**
 * The Weather Network publishes rainfall as a qualitative band per day
 * ("<1 mm", "1-3 mm", "~5 mm"); days with no band are dry.
 */
function rainBand(segment: string) {
  const range = segment.match(/Rain amount\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const about = segment.match(/Rain amount\s*~\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (about) return Number(about[1]);
  const under = segment.match(/Rain amount\s*<\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (under) return Number(under[1]) / 2;
  return 0;
}

async function fetchWeatherNetwork(monthDays: Set<string>) {
  const text = await getText(baseline.network.url);
  const heads = [...text.matchAll(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/g)];
  const days: Day[] = [];
  heads.forEach((head, index) => {
    const key = monthDayKey(head[1], head[2]);
    if (!key) return;
    const start = head.index ?? 0;
    const segment = text.slice(start, heads[index + 1]?.index ?? start + 400);
    const pop = segment.match(/P\.O\.P\.\s*(?:Sun\s*)?(\d{1,3})\s*%/i);
    days.push({ key, mm: rainBand(segment), pop: pop ? Number(pop[1]) : null });
  });
  return summarise("network", days, monthDays);
}

async function fetchWeather25(monthDays: Set<string>) {
  const text = await getText(baseline.weather25.url);
  const days: Day[] = [];
  for (const match of text.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d+(?:\.\d+)?)\s*mm/gi)) {
    const key = monthDayKey(match[1], match[2]);
    if (key) days.push({ key, mm: Number(match[3]), pop: null });
  }
  return summarise("weather25", days, monthDays);
}

function fallback(key: Key, reason: string, windowDays: number): Source {
  return { ...baseline[key], status: "baseline", days: windowDays, reason };
}

function settle(key: Key, result: PromiseSettledResult<Source>, windowDays: number): Source {
  if (result.status === "fulfilled") return result.value;
  const error = result.reason;
  const message = error?.name === "AbortError" ? "timed out" : String(error?.message ?? error);
  return fallback(key, message, windowDays);
}

export async function GET() {
  const { dates, monthDays } = forecastWindow();
  const windowDays = dates.length;

  const [openMeteo, network, weather25] = await Promise.allSettled([
    fetchOpenMeteo(monthDays),
    fetchWeatherNetwork(monthDays),
    fetchWeather25(monthDays),
  ]);

  const openMeteoError = openMeteo.status === "rejected"
    ? String(openMeteo.reason?.message ?? openMeteo.reason)
    : "";

  const sources: Record<Key, Source> = {
    met: openMeteo.status === "fulfilled" ? openMeteo.value.met : fallback("met", openMeteoError, windowDays),
    // Timeanddate serves a Cloudflare interstitial to non-browser clients, so
    // there is nothing to parse without defeating their bot protection.
    time: fallback("time", "blocked by bot protection", windowDays),
    network: settle("network", network, windowDays),
    weather25: settle("weather25", weather25, windowDays),
    ecmwf: openMeteo.status === "fulfilled" ? openMeteo.value.ecmwf : fallback("ecmwf", openMeteoError, windowDays),
  };

  const keys = Object.keys(baseline) as Key[];

  // Sources reach different distances into the window — UKMO runs out around
  // day 7 while ECMWF covers a fortnight — so totals are only comparable once
  // each is reduced to a daily rate and projected back across the whole window.
  const amount = keys.reduce((sum, key) => {
    const source = sources[key];
    const perDay = source.days > 0 ? source.amount / source.days : 0;
    return sum + perDay * weights[key];
  }, 0) * windowDays;
  const probability = keys.reduce((sum, key) => sum + sources[key].probability * weights[key], 0);

  const withWeights = Object.fromEntries(keys.map(key => [key, {
    ...sources[key],
    weight: weights[key],
    coverage: `${sources[key].days}/${windowDays} days`,
  }]));

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    tripStart: TRIP_START,
    window: { from: dates[0], to: dates[dates.length - 1], days: windowDays },
    liveSources: keys.filter(key => sources[key].status === "live").length,
    amount: Number(amount.toFixed(2)),
    probability: Number(probability.toFixed(2)),
    sources: withWeights,
  }, {
    headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=300" },
  });
}
