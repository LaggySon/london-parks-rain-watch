import { NextResponse } from "next/server";
import { resolveWindow } from "../../../lib/window.mjs";

export const dynamic = "force-dynamic";

const LATITUDE = 51.5074;
const LONGITUDE = -0.1278;
const TIMEOUT_MS = 8000;

/**
 * Only numerical weather prediction models, served through Open-Meteo's model endpoint with
 * documented units and provenance.
 *
 * Earlier versions of this route also scraped three consumer forecast sites. They have been
 * removed rather than fixed, because none of them could be trusted for a water balance:
 * Timeanddate served a Cloudflare interstitial to every non-browser client; The Weather
 * Network publishes rainfall only as qualitative bands ("<1 mm", "1-3 mm", "~5 mm") that a
 * regex had to midpoint into a number; and Weather25 publishes no probability at all, so its
 * "chance of rain" was invented by a curve in this file. A rebadged, regex-parsed number is
 * not a second opinion - it is noise wearing a brand.
 */
const MODELS = {
  ecmwf: {
    id: "ecmwf_ifs025",
    label: "ECMWF IFS",
    url: "https://open-meteo.com/en/docs/ecmwf-api",
    /** Consistently the most skilful global model over NW Europe, and the only one of the
     * four that covers the whole window with a published probability. */
    share: 0.40,
  },
  ukmo: {
    id: "ukmo_seamless",
    label: "Met Office (UKMO)",
    url: "https://open-meteo.com/en/docs/ukmo-api",
    /** The national model, strong at short range over the UK, but it publishes no
     * probability of precipitation through this endpoint - see `probabilityShare`. */
    share: 0.25,
  },
  icon: {
    id: "icon_seamless",
    label: "DWD ICON",
    url: "https://open-meteo.com/en/docs/dwd-api",
    share: 0.20,
  },
  gfs: {
    id: "gfs_seamless",
    label: "NOAA GFS",
    url: "https://open-meteo.com/en/docs/gfs-api",
    /** Weakest of the four for European rainfall, but genuinely independent of ECMWF. */
    share: 0.15,
  },
};

type Key = keyof typeof MODELS;
const KEYS = Object.keys(MODELS) as Key[];

type Source = {
  label: string;
  url: string;
  /** Total rainfall over the days this model actually covers, mm. */
  amount: number;
  /** Highest daily chance of rain across the window, or null if the model publishes none. */
  probability: number | null;
  days: number;
  probabilityDays: number;
  reason?: string;
};

/** Weights over an arbitrary subset of the models, normalised to sum to 1. */
function weightsOver(keys: Key[]) {
  const total = keys.reduce((sum, key) => sum + MODELS[key].share, 0);
  return Object.fromEntries(
    keys.map((key) => [key, total > 0 ? MODELS[key].share / total : 0]),
  ) as Record<Key, number>;
}

async function fetchModels(inWindow: Set<string>) {
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${LATITUDE}&longitude=${LONGITUDE}`
    + "&daily=precipitation_sum,precipitation_probability_max"
    + "&timezone=Europe%2FLondon&forecast_days=16"
    + `&models=${KEYS.map((key) => MODELS[key].id).join(",")}`;

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

  const time: string[] = payload?.daily?.time ?? [];
  const indices = time.map((date, i) => ({ date, i })).filter(({ date }) => inWindow.has(date));
  if (!indices.length) throw new Error("no forecast days inside the window");

  const sources = {} as Record<Key, Source>;
  /** Per-model rainfall by date, so the blend can be done a day at a time. */
  const byDate = {} as Record<Key, Map<string, number>>;

  for (const key of KEYS) {
    const model = MODELS[key];
    const sums: (number | null)[] = payload?.daily?.[`precipitation_sum_${model.id}`] ?? [];
    const pops: (number | null)[] = payload?.daily?.[`precipitation_probability_max_${model.id}`] ?? [];
    const rain = new Map<string, number>();
    indices.forEach(({ date, i }) => {
      if (sums[i] != null) rain.set(date, sums[i] as number);
    });
    const chances = indices.map(({ i }) => pops[i]).filter((pop): pop is number => pop != null);
    byDate[key] = rain;
    sources[key] = {
      label: model.label,
      url: model.url,
      amount: Number([...rain.values()].reduce((total, mm) => total + mm, 0).toFixed(1)),
      // No probability published means no probability reported. Inventing one from the
      // rainfall total, as this route used to, dresses up a guess as a forecast.
      probability: chances.length ? Math.max(...chances) : null,
      days: rain.size,
      probabilityDays: chances.length,
    };
  }
  return { sources, byDate };
}

export async function GET(request: Request) {
  // The window is a request parameter, so the page can ask about a different trip without a
  // redeploy. Dates that cannot be modelled are rejected here rather than turned into an
  // empty forecast further down, where the reason would be lost.
  const requested = resolveWindow(new URL(request.url).searchParams);
  if (requested.error) {
    return NextResponse.json({ error: requested.error, limits: requested.limits }, { status: 400 });
  }
  const { dates, arrival, notes, limits } = requested;
  const inWindow: Set<string> = new Set(dates);
  const windowDays = dates.length;

  let sources: Record<Key, Source>;
  let byDate: Record<Key, Map<string, number>>;
  try {
    ({ sources, byDate } = await fetchModels(inWindow));
  } catch (error: any) {
    const reason = error?.name === "AbortError" ? "timed out" : String(error?.message ?? error);
    return NextResponse.json({ error: `forecast models unavailable: ${reason}` }, { status: 503 });
  }

  // The models reach different distances into the window: UKMO and ICON run out around day 7
  // while ECMWF and GFS cover the fortnight. So the blend is done a day at a time, with the
  // weights renormalised over whichever models actually cover that day.
  //
  // An earlier version instead reduced each model to a daily rate and projected it across the
  // whole window, which quietly turned UKMO's 7-day forecast into a 15-day number the Met
  // Office never issued. Blending per day keeps every millimetre traceable to a model that
  // really forecast that day - and lets the strongest UK model contribute where it is
  // strongest, the first week, which is also the week that matters most for green-up.
  const perDay = dates.map((date) => {
    const present = KEYS.filter((key) => byDate[key].has(date));
    const weights = weightsOver(present);
    return {
      date,
      mm: Number(present.reduce(
        (sum, key) => sum + (byDate[key].get(date) as number) * weights[key], 0).toFixed(2)),
      models: present.length,
    };
  });
  const amount = perDay.reduce((sum, day) => sum + day.mm, 0);
  const withRain = KEYS.filter((key) => sources[key].days > 0);
  const rainWeights = weightsOver(withRain);

  // The probability average covers only the models that publish one, renormalised over that
  // subset, so a silent model neither drags the number down nor gets a number invented for it.
  const withProbability = KEYS.filter((key) => sources[key].probability != null);
  const probabilityWeights = weightsOver(withProbability);
  const probability = withProbability.length
    ? withProbability.reduce(
      (sum, key) => sum + (sources[key].probability as number) * probabilityWeights[key], 0)
    : null;

  // A model's nominal share is what it carries on a day it covers; its effective share is
  // what it carries across the whole window, which is lower for anything that stops early.
  const effectiveWeight = (key: Key) => dates.reduce((sum, date) => {
    if (!byDate[key].has(date)) return sum;
    return sum + weightsOver(KEYS.filter((k) => byDate[k].has(date)))[key];
  }, 0) / (windowDays || 1);

  const detailed = Object.fromEntries(KEYS.map((key) => [key, {
    ...sources[key],
    weight: Number(effectiveWeight(key).toFixed(3)),
    nominalWeight: MODELS[key].share,
    probabilityWeight: probabilityWeights[key] ?? 0,
    coverage: `${sources[key].days}/${windowDays} days`,
  }]));

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    tripStart: arrival,
    window: { from: dates[0], to: dates[dates.length - 1], days: windowDays },
    /** How far the pickers on the page may reach, and any correction made to what they asked. */
    limits,
    notes,
    modelCount: KEYS.length,
    liveSources: withRain.length,
    amount: Number(amount.toFixed(2)),
    /** Highest daily chance of rain in the window, weighted across the models that publish
     * one. This is "will it rain at all", not "will there be enough to green the parks" -
     * that question is answered by /api/greenness. */
    probability: probability == null ? null : Number(probability.toFixed(2)),
    probabilityBasis: withProbability.map((key) => MODELS[key].label),
    perDay,
    sources: detailed,
  }, {
    headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=300" },
  });
}
