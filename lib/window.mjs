/**
 * The modelled window, resolved from request parameters rather than hardcoded.
 *
 * Both API routes used to carry their own copy of a single constant — 28 August 2026, the
 * arrival this dashboard was built for — and derive "today until then" from it. That made
 * the one question a visitor is most likely to want to change the one thing only a code
 * edit could change. Here the window is a parameter with that trip as its default.
 *
 * Two dates describe it:
 *
 *   - `from`, the first day counted. Defaults to today in London.
 *   - `arrival`, the day you get there. Rain is counted *up to but not including* it, which
 *     is the long-standing convention in this project: rain falling on the day you walk into
 *     the park has not had time to change what you are looking at. So the last day of the
 *     window is the day before arrival, and a window can legitimately end on the morning
 *     after the last day the forecast covers.
 *
 * Bounds are enforced here rather than left to the upstream. A window that reaches past the
 * forecast horizon is quietly clamped and says so, because the horizon is a property of
 * Open-Meteo that no visitor can be expected to know; a window that runs backwards is
 * rejected, because there is no honest answer to give and guessing at one would hide a
 * typo. Deliberately free of I/O so it can be exercised directly by
 * scripts/check-window.mjs.
 */

/** The trip this dashboard was built for, used when a request names no arrival date. */
export const DEFAULT_ARRIVAL = "2026-08-28";

/**
 * How far ahead the Open-Meteo endpoints used here reach: `forecast_days=16` is today plus
 * fifteen more. The latest *arrival* that can be modelled is therefore today + 16, since
 * the arrival day itself sits outside the window and needs no forecast of its own.
 */
export const FORECAST_DAYS = 16;

const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Europe/London, which is the calendar the whole dashboard runs on. */
export function londonToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * Milliseconds for an ISO date, or NaN if it is not one.
 *
 * The round-trip check is what rejects a well-formed impossibility like `2026-02-31`, which
 * `Date` would otherwise roll forward into March without complaint.
 */
function parse(iso) {
  if (typeof iso !== "string" || !ISO_DATE.test(iso)) return NaN;
  const time = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(time)) return NaN;
  return new Date(time).toISOString().slice(0, 10) === iso ? time : NaN;
}

export function addDays(iso, days) {
  return new Date(parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`; negative if `b` is the earlier of the two. */
export function daysBetween(a, b) {
  return Math.round((parse(b) - parse(a)) / DAY_MS);
}

/** Every date from `from` up to, but not including, `until`. */
export function datesBetween(from, until) {
  const dates = [];
  for (let date = from; date < until; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/**
 * The window a request asked for, corrected to one that can actually be modelled.
 *
 * Returns `{ error }` for input no correction can rescue, and otherwise the resolved window
 * plus `notes`, one line per correction applied. The notes are surfaced in the response so
 * a caller whose dates were moved finds out from the page rather than from a number that
 * quietly answers a different question than the one asked.
 *
 * @param {URLSearchParams} params
 * @param {string} [today] ISO date; injectable so the resolver can be tested off the clock.
 */
export function resolveWindow(params, today = londonToday()) {
  const limits = { earliestFrom: today, latestArrival: addDays(today, FORECAST_DAYS) };
  const notes = [];

  const asked = (name, fallback) => {
    const raw = params?.get(name);
    if (raw == null || raw === "") return fallback;
    return raw.trim();
  };

  const fromAsked = asked("from", today);
  const arrivalAsked = asked("arrival", DEFAULT_ARRIVAL);

  for (const [name, value] of [["from", fromAsked], ["arrival", arrivalAsked]]) {
    if (Number.isNaN(parse(value))) {
      return { error: `${name}=${value} is not a date; use YYYY-MM-DD`, limits };
    }
  }

  // An arrival that has already happened leaves nothing to forecast, and clamping it to
  // tomorrow would answer a question nobody asked.
  if (arrivalAsked <= today) {
    return {
      error: `arrival=${arrivalAsked} is not after today (${today}); there is no window to`
        + " forecast. Pick an arrival at least one day ahead.",
      limits,
    };
  }

  let arrival = arrivalAsked;
  if (arrival > limits.latestArrival) {
    arrival = limits.latestArrival;
    notes.push(`The forecast reaches ${FORECAST_DAYS} days ahead, so the window ends at`
      + ` ${arrival} rather than ${arrivalAsked}.`);
  }

  let from = fromAsked;
  if (from < today) {
    from = today;
    notes.push(`The window starts today (${today}); ${fromAsked} is in the past, and past`
      + " weather is already part of the model's history rather than its forecast.");
  }
  if (from >= arrival) {
    from = addDays(arrival, -1);
    notes.push(`The window starts ${from}, the last day before arrival; ${fromAsked} is not`
      + " before it.");
  }

  const dates = datesBetween(from, arrival);
  return {
    from,
    arrival,
    dates,
    /** Last day *in* the window, which is the day before arrival. */
    to: dates[dates.length - 1],
    days: dates.length,
    /** How far ahead the upstream data reaches, so a UI can bound its own date pickers. */
    limits,
    notes,
  };
}
