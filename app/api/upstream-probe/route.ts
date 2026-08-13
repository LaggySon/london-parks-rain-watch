import { NextResponse } from "next/server";

/**
 * A fixed set of Open-Meteo requests, reported by what came back.
 *
 * This exists because `/api/greenness` failed in production while succeeding from a laptop
 * against the identical URL: Open-Meteo answered HTTP 200 and silently omitted the whole
 * `daily` block, honouring `timezone` and `hourly` in the same request. A difference that
 * only appears from one network cannot be reproduced locally, so the probe runs from the
 * place that sees it, and varies one thing at a time to find which parameter is refused.
 *
 * The URL list is hard-coded on purpose. Taking a URL from the query string would turn a
 * public endpoint into an open proxy.
 */
export const dynamic = "force-dynamic";

const LATITUDE = 51.5074;
const LONGITUDE = -0.1278;
const TIMEOUT_MS = 12000;
const POINT = `latitude=${LATITUDE}&longitude=${LONGITUDE}`;

/** Each case changes one thing from the case above it. */
const CASES: { name: string; query: string }[] = [
  { name: "1 daily, one variable, no range", query: `${POINT}&daily=precipitation_sum` },
  { name: "2 daily, one variable, timezone", query: `${POINT}&daily=precipitation_sum&timezone=Europe%2FLondon` },
  { name: "3 daily, one variable, forecast_days=16", query: `${POINT}&daily=precipitation_sum&forecast_days=16` },
  { name: "4 daily, one variable, past_days=92", query: `${POINT}&daily=precipitation_sum&past_days=92` },
  { name: "5 daily, one variable, past_days=7", query: `${POINT}&daily=precipitation_sum&past_days=7` },
  { name: "6 daily, add et0", query: `${POINT}&daily=precipitation_sum,et0_fao_evapotranspiration` },
  { name: "7 daily, add temperatures", query: `${POINT}&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_mean` },
  { name: "8 hourly only", query: `${POINT}&hourly=soil_moisture_0_to_7cm` },
  { name: "9 current only", query: `${POINT}&current=temperature_2m` },
  { name: "10 the greenness route's exact request", query: `${POINT}&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_mean&hourly=soil_moisture_0_to_7cm,soil_moisture_7_to_28cm&timezone=Europe%2FLondon&past_days=92&forecast_days=16` },
];

async function probe(query: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = `https://api.open-meteo.com/v1/forecast?${query}`;
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text.length ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      query,
      status: response.status,
      // Which Cloudflare colo served it, and whether it was a cache hit: the two things
      // that differ between one network and another.
      via: {
        server: response.headers.get("server"),
        ray: response.headers.get("cf-ray"),
        cache: response.headers.get("cf-cache-status"),
        age: response.headers.get("age"),
      },
      bytes: text.length,
      keys: payload && typeof payload === "object" ? Object.keys(payload) : null,
      dailyDays: payload?.daily?.time?.length ?? null,
      hourlyHours: payload?.hourly?.time?.length ?? null,
      reason: payload?.reason ?? null,
      body: payload?.daily || payload?.hourly ? null : text.slice(0, 300),
    };
  } catch (error) {
    return { query, error: String((error as Error).message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** The greenness route's own weather request, unchanged. */
const WEATHER = `${POINT}&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max`
  + ",temperature_2m_mean&hourly=soil_moisture_0_to_7cm,soil_moisture_7_to_28cm"
  + "&timezone=Europe%2FLondon&past_days=92&forecast_days=16";

/**
 * The one difference left between the two routes.
 *
 * Every URL above succeeds from production when asked for on its own, including the exact
 * request the greenness route makes - yet that route still gets no `daily` block. What it
 * does differently is fire the weather request *concurrently* with two calls to a second
 * host, `ensemble-api.open-meteo.com`, inside one `Promise.allSettled`. So ask the same
 * question three ways: alone, alongside those two calls, and after them.
 */
async function ensemble(model: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = "https://ensemble-api.open-meteo.com/v1/ensemble"
    + `?${POINT}&daily=precipitation_sum&timezone=Europe%2FLondon&forecast_days=16&models=${model}`;
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const payload: any = await response.json().catch(() => null);
    return { model, status: response.status, days: payload?.daily?.time?.length ?? null };
  } catch (error) {
    return { model, error: String((error as Error).message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function concurrencyCases() {
  const alone = await probe(WEATHER);

  // Exactly the shape of the greenness route's own call.
  const [together, ...ensembles] = await Promise.all([
    probe(WEATHER), ensemble("gfs05"), ensemble("gem_global"),
  ]);

  const afterwards = await probe(WEATHER);

  return [
    { case: "11 weather alone", dailyDays: alone.dailyDays, bytes: alone.bytes },
    {
      case: "12 weather concurrent with both ensemble calls",
      dailyDays: together.dailyDays,
      bytes: together.bytes,
      ensembles,
    },
    { case: "13 weather after the ensemble calls finish", dailyDays: afterwards.dailyDays, bytes: afterwards.bytes },
  ];
}

export async function GET() {
  // In series, one at a time: the point is to compare replies, not to hammer a free API.
  const results = [];
  for (const item of CASES) {
    results.push({ case: item.name, ...(await probe(item.query)) });
  }
  results.push(...(await concurrencyCases()) as any);
  return NextResponse.json({ ranAt: new Date().toISOString(), results }, {
    headers: { "Cache-Control": "no-store" },
  });
}
