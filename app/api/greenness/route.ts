import { NextResponse } from "next/server";
import {
  MODEL, PARKS, profile, createState, runPark, relativeWater,
  availableFractionFromTheta, sitVerdict, rainNeeded, satisfyingCases, percentile,
} from "../../../lib/greenness.mjs";

export const dynamic = "force-dynamic";

const ARRIVAL = "2026-08-28";
const LATITUDE = 51.5074;
const LONGITUDE = -0.1278;
const TIMEOUT_MS = 12000;
/** Long enough to establish how parched the ground already is: the dominant factor. */
const HISTORY_DAYS = 92;
/**
 * A second, lower milestone below the model's "noticeably green" threshold: green visibly
 * flushing through the straw. Needed because a park can be far enough gone that no ensemble
 * member reaches the higher bar, and "0% chance" alone hides whether it was close.
 */
const GREENING_THRESHOLD = 0.25;

/**
 * Ensemble models carrying enough members and reaching far enough ahead to be useful.
 * Measured while building this: gfs05 returns 31 members and gem_global 21, both covering
 * the whole window. icon_eu reaches only about a third of it, and ecmwf_ifs04 and
 * bom_access_global_ensemble return nothing for this point, so all three are excluded.
 */
const ENSEMBLES = ["gfs05", "gem_global"];

/**
 * Thames Water announced a Temporary Use Ban on 23 July 2026, and the whole of London is
 * officially in drought. The ban prohibits watering lawns and gardens with a hosepipe or
 * sprinkler; the published exemptions cover food crops and certain newly planted trees, but
 * not amenity turf. Watering cans stay legal and some Royal Parks hold their own
 * abstraction, so the model keeps a small residual rather than zeroing irrigation.
 *
 * This is a hand-maintained constant. Restrictions are published as press releases and
 * JavaScript-rendered help pages rather than as an API, so scraping them per request would
 * be fragile; update this when the ban is lifted.
 */
const HOSEPIPE_BAN = {
  inForce: true,
  since: "2026-07-23",
  authority: "Thames Water",
  url: "https://www.thameswater.co.uk/help/temporary-hosepipe-ban",
};

type Daily = {
  date: string;
  mm: number;
  et0: number | null;
  tmax: number | null;
  tmean: number | null;
};

function londonToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * A reply, described well enough to diagnose from the outside.
 *
 * The first version of this returned `await response.json()` and threw bare strings, which
 * cost a production outage: `/api/greenness` answered 503 "no daily data returned" from
 * Vercel while the identical URL returned 108 days of weather from a laptop, and nothing in
 * the response said what the upstream had actually sent. Keeping the status, the content
 * type, the size and the top-level keys turns that from a guess into a fact.
 */
type Reply = {
  ok: boolean;
  status: number;
  contentType: string;
  bytes: number;
  payload: any;
  parseError: string | null;
  snippet: string;
};

async function fetchReply(url: string): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let payload: any = null;
    let parseError: string | null = null;
    try {
      payload = text.length ? JSON.parse(text) : null;
    } catch (error) {
      parseError = String((error as Error).message);
    }
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "(none)",
      bytes: text.length,
      payload,
      parseError,
      // Enough of the body to recognise a rate-limit notice or an interstitial, and short
      // enough to be safe to show: these URLs carry no credentials.
      snippet: text.slice(0, 200).replace(/\s+/g, " ").trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which JavaScript runtime this route was built for.
 *
 * Worth reporting because the probe route and this one disagree about the same URL on the
 * same deployment, and a route quietly built for a different runtime would explain it: the
 * two do not share a fetch implementation.
 */
function runtime() {
  return [
    `NEXT_RUNTIME=${process.env.NEXT_RUNTIME ?? "(unset)"}`,
    typeof (globalThis as any).EdgeRuntime === "undefined" ? "node-like" : "EdgeRuntime",
    `region=${process.env.VERCEL_REGION ?? "(unset)"}`,
  ].join(" ");
}

/** One line saying what came back, for an error message or the diagnostics block. */
function describe(reply: Reply) {
  const keys = reply.payload && typeof reply.payload === "object"
    ? Object.keys(reply.payload).join(",") : "(not an object)";
  return [
    `HTTP ${reply.status}`,
    reply.contentType.split(";")[0],
    `${reply.bytes}b`,
    reply.parseError ? `unparseable: ${reply.parseError}` : `keys=${keys}`,
    // Open-Meteo explains refusals in `reason`; anything else, quote the body.
    reply.payload?.reason ? `reason=${reply.payload.reason}`
      : (reply.payload?.daily ? "" : `body=${reply.snippet}`),
  ].filter(Boolean).join(" ");
}

async function fetchJson(url: string) {
  const reply = await fetchReply(url);
  if (!reply.ok || reply.parseError) throw new Error(describe(reply));
  return reply.payload;
}

const DAILY_FIELDS = "precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_mean";
const SOIL_FIELDS = "soil_moisture_0_to_7cm,soil_moisture_7_to_28cm";

/**
 * Build the request from parameters rather than by gluing strings together.
 *
 * The string-concatenated version of this URL reached production missing its entire
 * `&daily=...` segment - the one operand of the `+` chain that was a plain literal sitting
 * between two template literals - while dev and every hand-run copy of the same URL was
 * fine. Open-Meteo was answering the question it was actually asked: no `daily` requested,
 * no `daily` returned, HTTP 200, and a 186-byte reply.
 *
 * `URLSearchParams` cannot lose a parameter the way a concatenation chain can, and it
 * encodes the timezone slash itself.
 */
function weatherUrl(withHourly: boolean) {
  const params = new URLSearchParams({
    latitude: String(LATITUDE),
    longitude: String(LONGITUDE),
    daily: DAILY_FIELDS,
    timezone: "Europe/London",
    past_days: String(HISTORY_DAYS),
    forecast_days: "16",
  });
  if (withHourly) params.set("hourly", SOIL_FIELDS);
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

/**
 * The same URL built the two other plausible ways, reported but never sent.
 *
 * Kept only until the cause is confirmed in production: it says which construction loses the
 * parameter, which is the difference between a build-level fault and a source-level one.
 */
function urlBuildAudit() {
  const chained = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${LATITUDE}&longitude=${LONGITUDE}`
    + "&daily=" + DAILY_FIELDS
    + `&timezone=Europe%2FLondon&past_days=${HISTORY_DAYS}&forecast_days=16`;
  const single = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}`
    + `&longitude=${LONGITUDE}&daily=${DAILY_FIELDS}`
    + `&timezone=Europe%2FLondon&past_days=${HISTORY_DAYS}&forecast_days=16`;
  const has = (url: string) => (url.includes("daily=") ? "keeps-daily" : "LOSES-DAILY");
  return `builds: chained=${has(chained)} single=${has(single)}`
    + ` params=${has(weatherUrl(false))} literal=${has("&daily=" + DAILY_FIELDS)}`;
}

/**
 * One call covers both halves of the question: `past_days` gives the weather that made the
 * ground what it is, `forecast_days` what is still to come. Hourly soil moisture rides
 * along as an independent check on the modelled water balance.
 *
 * The daily series is load-bearing and the hourly soil moisture is not — it only anchors and
 * audits the balance — so the two are allowed to fail separately. If the combined request
 * comes back without a daily series, the daily half is asked for again on its own rather than
 * taking the whole model down with it; a park with no anchor is still worth reporting, a park
 * with no weather is not.
 */
async function fetchWeather() {
  const attempts: string[] = [runtime(), urlBuildAudit()];
  const ask = async (label: string, url: string) => {
    const reply = await fetchReply(url);
    // Quote the URL, rather than trusting that it is the one in the source. The probe route
    // sends what looks like the same request and gets a different answer, so "what looks
    // like the same request" is exactly the assumption that needs testing.
    attempts.push(`${label}: ${describe(reply)} url=${url}`);
    return reply;
  };

  let reply = await ask("daily+hourly", weatherUrl(true));
  if (!reply.payload?.daily?.time?.length) {
    reply = await ask("daily only", weatherUrl(false));
  }
  const payload = reply.payload;
  const daily = payload?.daily;
  if (!daily?.time?.length) throw new Error(`no daily data returned — ${attempts.join(" | ")}`);

  const series: Daily[] = daily.time.map((date: string, i: number) => ({
    date,
    mm: daily.precipitation_sum?.[i] ?? 0,
    et0: daily.et0_fao_evapotranspiration?.[i] ?? null,
    tmax: daily.temperature_2m_max?.[i] ?? null,
    tmean: daily.temperature_2m_mean?.[i] ?? null,
  }));

  // Midday readings avoid the diurnal swing in the top layer.
  const hourly = payload?.hourly;
  const noon: { date: string; shallow: number | null; deep: number | null }[] = [];
  (hourly?.time ?? []).forEach((stamp: string, i: number) => {
    if (!stamp.endsWith("12:00")) return;
    noon.push({
      date: stamp.slice(0, 10),
      shallow: hourly.soil_moisture_0_to_7cm?.[i] ?? null,
      deep: hourly.soil_moisture_7_to_28cm?.[i] ?? null,
    });
  });

  return {
    series,
    noon,
    units: payload?.hourly_units?.soil_moisture_0_to_7cm ?? "m³/m³",
    attempts,
  };
}

/** Per-member daily rainfall for one ensemble model, keyed by date. */
async function fetchEnsemble(model: string) {
  const url = "https://ensemble-api.open-meteo.com/v1/ensemble"
    + `?latitude=${LATITUDE}&longitude=${LONGITUDE}`
    + "&daily=precipitation_sum&timezone=Europe%2FLondon&forecast_days=16"
    + `&models=${model}`;
  const payload = await fetchJson(url);
  const daily = payload?.daily;
  if (!daily?.time?.length) throw new Error(`${model}: no data`);

  const dates: string[] = daily.time;
  const members = Object.keys(daily)
    .filter((key) => key.startsWith("precipitation_sum"))
    .map((key) => {
      const values: (number | null)[] = daily[key];
      const byDate = new Map<string, number>();
      dates.forEach((date, i) => {
        if (values[i] != null) byDate.set(date, values[i] as number);
      });
      return { model, key, byDate };
    });
  return members;
}

export async function GET() {
  const today = londonToday();
  const [weather, ...ensembleResults] = await Promise.allSettled([
    fetchWeather(),
    ...ENSEMBLES.map((model) => fetchEnsemble(model)),
  ]);

  // Failures get a short cache of their own. Without one, every visitor to a broken page
  // starts a fresh invocation that fails the same way, which is how a quiet outage turns
  // into a loud one.
  const failed = (error: string) => NextResponse.json({ error }, {
    status: 503,
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=60" },
  });

  if (weather.status === "rejected") {
    const reason = weather.reason?.name === "AbortError"
      ? "timed out" : String(weather.reason?.message ?? weather.reason);
    return failed(`weather unavailable: ${reason}`);
  }

  const { series, noon, units, attempts } = weather.value;
  const history = series.filter((day) => day.date < today);
  const forecast = series.filter((day) => day.date >= today && day.date < ARRIVAL);
  if (!history.length || !forecast.length) {
    return failed(`forecast window is empty — ${series.length} days returned,`
      + ` ${series[0]?.date} to ${series[series.length - 1]?.date}, today ${today}`);
  }

  // --- soil moisture: initialises the spin-up and then audits its answer
  const withReading = noon.filter((entry) => entry.shallow != null);
  const first = withReading[0];
  const latest = [...withReading].reverse().find((entry) => entry.date <= today) ?? first;

  // The ban started part-way through the history, so the spin-up runs in two legs rather
  // than pretending the whole summer was restricted.
  const beforeBan = HOSEPIPE_BAN.inForce
    ? history.filter((day) => day.date < HOSEPIPE_BAN.since) : history;
  const afterBan = HOSEPIPE_BAN.inForce
    ? history.filter((day) => day.date >= HOSEPIPE_BAN.since) : [];

  // --- ensembles: precipitation is the only field that varies per member. Per-model ET0
  // is too patchy to use (UKMO returned 2 of 16 days), so demand is shared across members
  // and only the rain differs. That understates the true spread a little, since a wet
  // member would also be a duller, cooler one.
  const dates = forecast.map((day) => day.date);
  const members = ensembleResults
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((member) => dates.every((date) => member.byDate.has(date)));
  const ensembleErrors = ensembleResults
    .map((result, i) => (result.status === "rejected"
      ? `${ENSEMBLES[i]}: ${String(result.reason?.message ?? result.reason)}` : null))
    .filter(Boolean);

  const memberDays = members.map((member) =>
    forecast.map((day) => ({ ...day, mm: member.byDate.get(day.date) as number })));
  const memberRainTotals = memberDays.map((days) =>
    days.reduce((sum, day) => sum + day.mm, 0));

  // --- drought context
  const rain90 = history.reduce((sum, day) => sum + day.mm, 0);
  const et090 = history.reduce((sum, day) => sum + (day.et0 ?? 0), 0);
  const last30 = history.slice(-30);
  const forecastRain = forecast.reduce((sum, day) => sum + day.mm, 0);
  const forecastEt0 = forecast.reduce((sum, day) => sum + (day.et0 ?? 0), 0);

  // A fall smaller than the canopy threshold never reaches the soil, so "days since it
  // rained" is the wrong question — this is days since rain the grass could actually use.
  const lastWetting = [...history].reverse()
    .findIndex((day) => day.mm >= MODEL.CANOPY_CAPACITY_MM);
  const wettingDays = history.filter((day) => day.mm >= MODEL.CANOPY_CAPACITY_MM).length;

  const parks: Record<string, unknown> = {};

  for (const park of Object.values(PARKS) as any[]) {
    const shape = profile(park);
    // Anchor the starting bucket to measured soil moisture 92 days ago; if the reading is
    // missing, half-full is the least committal assumption available.
    const startShallow = first?.shallow == null
      ? 0.5 : availableFractionFromTheta(park, first.shallow);
    const startDeep = first?.deep == null
      ? startShallow : availableFractionFromTheta(park, first.deep);

    // 1. Spin up over the observed weather to establish today's state, unrestricted up to
    //    the ban and restricted after it.
    const early = runPark(park, beforeBan, {
      natural: createState(park, startShallow, startDeep),
      irrigated: createState(park, startShallow, startDeep),
      restricted: false,
    });
    const late = runPark(park, afterBan, {
      natural: early.natural,
      irrigated: early.irrigated,
      restricted: HOSEPIPE_BAN.inForce,
    });
    const spinUp = {
      natural: late.natural,
      irrigated: late.irrigated,
      series: [...early.series, ...late.series],
    };
    const start = {
      natural: spinUp.natural,
      irrigated: spinUp.irrigated,
      restricted: HOSEPIPE_BAN.inForce,
    };

    // 2. Project the deterministic forecast for the headline series.
    const projected = runPark(park, forecast, start);
    const arrival = projected.series[projected.series.length - 1];

    // 3. Project every ensemble member to get a distribution rather than one number.
    const memberRuns = memberDays.map((days) => runPark(park, days, start).series);
    const finals = memberRuns.map((run) => run[run.length - 1].greenness);
    const spread = finals.length
      ? {
        p10: percentile(finals, 0.1),
        median: percentile(finals, 0.5),
        p90: percentile(finals, 0.9),
        min: Math.min(...finals),
        max: Math.max(...finals),
      }
      : { p10: null, median: arrival.greenness, p90: null, min: null, max: null };

    const probGreen = finals.length
      ? finals.filter((g) => g >= MODEL.GREEN_THRESHOLD).length / finals.length
      : null;
    // After a drought this deep, "noticeably green" can be out of reach for every member,
    // and a flat zero tells you nothing about how close it came. A lower milestone - green
    // visibly flushing through the straw - keeps the answer informative.
    const probGreening = finals.length
      ? finals.filter((g) => g >= GREENING_THRESHOLD).length / finals.length
      : null;

    const sitFinals = memberRuns.map((run) => run[run.length - 1].sit);
    const sitMedian = sitFinals.length ? percentile(sitFinals, 0.5) : arrival.sit;
    const verdict = sitVerdict(sitMedian, arrival.dryness, spread.median ?? arrival.greenness);

    // Daily series for the sparkline: observed history, then the forecast with a fan.
    const timeline = [
      ...spinUp.series.map((day: any) => ({
        date: day.date, greenness: round(day.greenness), kind: "observed",
      })),
      ...projected.series.map((day: any, i: number) => {
        const across = memberRuns.map((run) => run[i].greenness);
        return {
          date: day.date,
          greenness: round(day.greenness),
          p10: across.length ? round(percentile(across, 0.1)) : null,
          p90: across.length ? round(percentile(across, 0.9)) : null,
          kind: "forecast",
        };
      }),
    ];

    parks[park.key] = {
      name: park.name,
      greenness: {
        deterministic: round(arrival.greenness),
        p10: round(spread.p10),
        median: round(spread.median),
        p90: round(spread.p90),
        min: round(spread.min),
        max: round(spread.max),
      },
      probablyGreen: round(probGreen),
      probablyGreening: round(probGreening),
      looksGreen: describeGreen(spread.median ?? arrival.greenness),
      goodToSitOn: { score: round(sitMedian), ...verdict },
      dryness: round(arrival.dryness),
      recoveryCeiling: round(arrival.ceiling),
      dormantDays: Math.round(arrival.dormantDays),
      watered: {
        // What the watered and unwatered halves of the park look like separately.
        fraction: round(arrival.irrigatedFraction),
        unrestrictedFraction: park.irrigatedFraction,
        greenness: round(arrival.irrigatedGreenness),
        unwateredGreenness: round(arrival.naturalGreenness),
        appliedMm: round(spinUp.irrigated.irrigationApplied, 1),
      },
      whatItWouldTake: {
        toLookGreen: tidyNeed(rainNeeded(park, start, forecast)),
        toStartGreening: tidyNeed(rainNeeded(park, start, forecast, GREENING_THRESHOLD)),
        // The sit-on-it bar is a different question from the colour bars and often a much
        // closer one, so it gets its own delta rather than being inferred from greenness.
        toSitOn: tidyNeed(
          rainNeeded(park, start, forecast, MODEL.SIT_THRESHOLD, "sit")),
        toSitOnAtAll: tidyNeed(
          rainNeeded(park, start, forecast, MODEL.SIT_MARGINAL_THRESHOLD, "sit")),
      },
      // Concrete ways that bar could be met: the same question asked of five different
      // rainfall patterns, because spread-out rain and one soaking need very different totals.
      sitCases: satisfyingCases(park, start, forecast).map(tidyCase),
      whatIf: whatIfCurves(park, start, forecast),
      soil: {
        type: shape.soil.label,
        availableWaterMm: round(shape.taw, 1),
        crownLayerMm: round(shape.shallowCap, 1),
        rootDepthM: park.rootDepthM,
        note: park.note,
      },
      anchor: {
        // If these two disagree sharply the bucket parameters are wrong. Both are shown
        // rather than reconciled, because the reanalysis has its own soil assumptions.
        modelledCrownAvailable: round(relativeWater(spinUp.natural, park).shallow),
        measuredCrownAvailable: round(availableFractionFromTheta(park, latest?.shallow)),
      },
      series: timeline,
    };
  }

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    arrival: ARRIVAL,
    window: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
    context: {
      historyDays: history.length,
      rain90: round(rain90, 1),
      et090: round(et090, 1),
      balance90: round(rain90 - et090, 1),
      rain30: round(last30.reduce((sum, day) => sum + day.mm, 0), 1),
      et030: round(last30.reduce((sum, day) => sum + (day.et0 ?? 0), 0), 1),
      forecastRain: round(forecastRain, 1),
      forecastEt0: round(forecastEt0, 1),
      forecastBalance: round(forecastRain - forecastEt0, 1),
      daysSinceSoilWetting: lastWetting < 0 ? null : lastWetting,
      soilWettingDays: wettingDays,
      wettingThresholdMm: MODEL.CANOPY_CAPACITY_MM,
      hottestDay: Math.max(...history.map((day) => day.tmax ?? -99)),
      soilMoisture: {
        shallow: latest?.shallow ?? null,
        deep: latest?.deep ?? null,
        measuredOn: latest?.date ?? null,
        units,
      },
    },
    ensemble: {
      members: members.length,
      models: ENSEMBLES,
      errors: ensembleErrors,
      rainToArrival: memberRainTotals.length ? {
        p10: round(percentile(memberRainTotals, 0.1), 1),
        median: round(percentile(memberRainTotals, 0.5), 1),
        p90: round(percentile(memberRainTotals, 0.9), 1),
        max: round(Math.max(...memberRainTotals), 1),
        over25mm: memberRainTotals.filter((total) => total > 25).length,
      } : null,
    },
    hosepipeBan: HOSEPIPE_BAN,
    // What each upstream call actually returned. Cheap to carry, and the only way to tell a
    // healthy answer from one that quietly lost its soil-moisture anchor - or to diagnose a
    // deployment that behaves differently from a laptop, which has already happened once.
    diagnostics: {
      weather: attempts,
      soilMoistureReadings: noon.filter((entry) => entry.shallow != null).length,
      anchored: noon.some((entry) => entry.shallow != null),
    },
    parks,
    model: {
      greenThreshold: MODEL.GREEN_THRESHOLD,
      greeningThreshold: GREENING_THRESHOLD,
      sitThreshold: MODEL.SIT_THRESHOLD,
      sitMarginalThreshold: MODEL.SIT_MARGINAL_THRESHOLD,
      canopyThresholdMm: MODEL.CANOPY_CAPACITY_MM,
      maxExtraMm: MODEL.MAX_EXTRA_MM,
      caveat: "Estimates from a soil-water-balance and turf model, not official forecasts. "
        + "Per-park soil, root depth and irrigation coverage are reasoned assumptions, not "
        + "measurements.",
      sources: [
        "FAO-56 (Allen et al.) Tables 12/19/22: crop coefficient, soil water characteristics, rooting depth and depletion fraction",
        "MORECS: the Met Office's operational UK grassland balance, which splits available water 40/60",
        "Kruse et al., PLOS ONE 17(9) e0271236 (2022): turf canopy intercepts 4.4 mm before any throughfall",
        "UMass Extension: 45-60+ dormant days leaves only ~70% recovery; green-up takes 2 weeks or more",
        "Iowa State Extension: 25 mm/week prevents dormancy, 6 mm/week keeps crowns alive without colour",
        "Beard (1973): cool-season shoot growth optimum 15.5-24 °C",
      ],
    },
  }, {
    headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=300" },
  });
}

function round(value: number | null | undefined, places = 3) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(places));
}

/**
 * Extra-rainfall steps for the what-if curves, in mm across the whole window.
 */
const WHATIF_STEPS = Array.from({ length: 21 }, (_, i) => i * 5);

/**
 * Pre-computed what-if curves, so the page's slider can demonstrate the lag without
 * shipping the model to the browser. The same extra rainfall is delivered two ways: spread
 * evenly across the window, and dumped in the last three days. The gap between the two
 * curves *is* the lag - grass cannot use water it has not had time to grow into.
 */
function whatIfCurves(park: any, start: any, forecast: Daily[]) {
  const tail = Math.min(3, forecast.length);
  const at = (days: Daily[], extraMm: number) => {
    const run = runPark(park, days, start).series;
    const end = run[run.length - 1];
    return { extraMm, greenness: round(end.greenness), sit: round(end.sit) };
  };
  return {
    spread: WHATIF_STEPS.map((total) => at(
      forecast.map((day) => ({ ...day, mm: day.mm + total / forecast.length })), total)),
    late: WHATIF_STEPS.map((total) => at(
      forecast.map((day, i) => (i >= forecast.length - tail
        ? { ...day, mm: day.mm + total / tail } : day)), total)),
    lateDays: tail,
  };
}

type Need = { extraMm: number | null; perDayMm: number | null; reachable: boolean };

function tidyNeed(need: Need) {
  return { ...need, perDayMm: round(need.perDayMm, 1) };
}

/** One delivery pattern, rounded to figures worth quoting, plus the words for its best outcome. */
function tidyCase(item: any) {
  const best = sitVerdict(item.peakSit, item.peakDryness, item.peakGreenness);
  return {
    ...item,
    perFallMm: round(item.perFallMm, 1),
    sit: round(item.sit),
    greenness: round(item.greenness),
    dryness: round(item.dryness),
    // How the park would read at the crossing total. Clearing the sit bar and looking green
    // are different questions, so this says which of them this pattern actually answers.
    looksGreen: item.greenness == null ? null : describeGreen(item.greenness).verdict,
    peakPerFallMm: round(item.peakPerFallMm, 1),
    peakSit: round(item.peakSit),
    peakGreenness: round(item.peakGreenness),
    peakDryness: round(item.peakDryness),
    // What this pattern amounts to at its best, in words: how it would read to sit on, and
    // how it would read to look at, which after a drought this deep are not the same answer.
    peakVerdict: best.verdict,
    peakDetail: best.detail,
    peakLooksGreen: describeGreen(item.peakGreenness).verdict,
  };
}

/** Words for how a park reads to someone walking into it. */
function describeGreen(greenness: number) {
  if (greenness >= 0.75) return { verdict: "Green", detail: "lush and evenly green" };
  if (greenness >= MODEL.GREEN_THRESHOLD) return { verdict: "Mostly green", detail: "green with tired patches" };
  if (greenness >= 0.25) return { verdict: "Patchy", detail: "green flushing through straw" };
  if (greenness >= 0.12) return { verdict: "Brown", detail: "straw with a faint green tinge" };
  return { verdict: "Brown", detail: "straw-coloured and dormant" };
}
