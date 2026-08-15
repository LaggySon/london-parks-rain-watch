/**
 * Behavioural checks for lib/window.mjs.
 *
 * The window resolver decides which dates the whole dashboard answers for, and it now takes
 * them from the query string, so it is the one place a bad request can quietly turn into a
 * confident answer about the wrong fortnight. It is pure and takes `today` as an argument,
 * so every case below is fixed in time and none of them depends on when this is run.
 *
 *   node scripts/check-window.mjs
 */

import {
  resolveWindow, addDays, daysBetween, datesBetween, DEFAULT_ARRIVAL, FORECAST_DAYS,
} from "../lib/window.mjs";

let failures = 0;

function check(name, condition, detail) {
  if (!condition) failures++;
  console.log(`${condition ? "  ok  " : " FAIL "} ${name}${detail ? `  ${detail}` : ""}`);
}

/** The date arithmetic runs on a fixed day, well clear of the trip this project defaults to. */
const TODAY = "2026-08-15";
const ask = (query, today = TODAY) => resolveWindow(new URLSearchParams(query), today);

console.log("\n--- date arithmetic");
{
  check("adding days crosses a month boundary", addDays("2026-08-30", 3) === "2026-09-02",
    addDays("2026-08-30", 3));
  check("subtracting days crosses it back", addDays("2026-09-02", -3) === "2026-08-30",
    addDays("2026-09-02", -3));
  check("a leap day is a real day", addDays("2028-02-28", 1) === "2028-02-29",
    addDays("2028-02-28", 1));
  check("days between two dates counts the gap, not the days named",
    daysBetween("2026-08-15", "2026-08-28") === 13);
  check("days between runs negative backwards",
    daysBetween("2026-08-28", "2026-08-15") === -13);
  check("a range excludes its end", datesBetween("2026-08-15", "2026-08-18").join(",")
    === "2026-08-15,2026-08-16,2026-08-17");
  check("an empty range is empty", datesBetween("2026-08-15", "2026-08-15").length === 0);
}

console.log("\n--- defaults: the trip this dashboard was built for");
{
  const w = ask("");
  check("no parameters means today until the default arrival",
    w.from === TODAY && w.arrival === DEFAULT_ARRIVAL, `${w.from} → ${w.arrival}`);
  check("the last day of the window is the day before arrival",
    w.to === addDays(DEFAULT_ARRIVAL, -1), w.to);
  check("the arrival day itself is not counted",
    !w.dates.includes(DEFAULT_ARRIVAL) && w.days === daysBetween(TODAY, DEFAULT_ARRIVAL),
    `${w.days} days`);
  check("nothing was corrected, so nothing is reported", w.notes.length === 0);
  check("blank parameters are the same as absent ones",
    ask("from=&arrival=").arrival === DEFAULT_ARRIVAL);
}

console.log("\n--- dates that were asked for and can be answered");
{
  const w = ask("from=2026-08-20&arrival=2026-08-25");
  check("a window inside the horizon is taken as asked",
    w.from === "2026-08-20" && w.arrival === "2026-08-25" && w.days === 5,
    `${w.from} → ${w.arrival}, ${w.days} days`);
  check("it was taken without correction", w.notes.length === 0);
  const shortest = ask("from=2026-08-20&arrival=2026-08-21");
  check("a one-day window is legitimate", shortest.days === 1 && !shortest.error);
  const tomorrow = ask("arrival=2026-08-16");
  check("arriving tomorrow leaves exactly today to forecast",
    tomorrow.days === 1 && tomorrow.from === TODAY);
}

console.log("\n--- the forecast horizon, which no visitor can be expected to know");
{
  const edge = ask(`arrival=${addDays(TODAY, FORECAST_DAYS)}`);
  check("an arrival exactly at the horizon is left alone",
    edge.notes.length === 0 && edge.days === FORECAST_DAYS, `${edge.days} days`);
  const far = ask("arrival=2027-01-01");
  check("an arrival past the horizon is clamped, not refused",
    !far.error && far.arrival === addDays(TODAY, FORECAST_DAYS), far.arrival);
  check("and the clamp is reported rather than absorbed",
    far.notes.length === 1 && far.notes[0].includes("2027-01-01"), far.notes[0]);
  check("the limits say how far the pickers may reach",
    far.limits.earliestFrom === TODAY
      && far.limits.latestArrival === addDays(TODAY, FORECAST_DAYS),
    `${far.limits.earliestFrom} → ${far.limits.latestArrival}`);
}

console.log("\n--- corrections: dates that are answerable once moved");
{
  const past = ask("from=2026-07-01");
  check("a start in the past becomes today, since past weather is history not forecast",
    past.from === TODAY && past.notes.length === 1, past.notes[0]);
  const inverted = ask("from=2026-08-26&arrival=2026-08-20");
  check("a start after arrival is pulled back to the day before it",
    inverted.from === "2026-08-19" && inverted.days === 1,
    `${inverted.from} → ${inverted.arrival}`);
  check("and that correction is reported too", inverted.notes.length === 1);
  const both = ask("from=2026-01-01&arrival=2027-01-01");
  check("two corrections produce two notes", both.notes.length === 2
    && both.from === TODAY && both.arrival === addDays(TODAY, FORECAST_DAYS));
}

console.log("\n--- refusals: dates no correction can rescue");
{
  check("a malformed date is refused by name",
    ask("arrival=next tuesday").error?.includes("arrival=next tuesday"),
    ask("arrival=next tuesday").error);
  check("a date that looks right but does not exist is refused",
    ask("arrival=2026-02-31").error?.includes("2026-02-31"));
  check("an American-ordered date is refused rather than reinterpreted",
    ask("arrival=08/28/2026").error?.includes("YYYY-MM-DD"));
  check("an arrival already past is refused, not nudged to tomorrow",
    ask("arrival=2026-08-01").error?.includes("no window"), ask("arrival=2026-08-01").error);
  check("arriving today is refused: there would be nothing left to forecast",
    ask(`arrival=${TODAY}`).error != null);
  check("a refusal still reports the limits, so a picker can offer a date that works",
    ask("arrival=2026-08-01").limits.latestArrival === addDays(TODAY, FORECAST_DAYS));
  check("a bad start date is refused as clearly as a bad arrival",
    ask("from=yesterday").error?.includes("from=yesterday"));
}

console.log("\n--- the resolver does not depend on when it is run");
{
  const later = ask("", "2026-08-20");
  check("a different today moves the window start with it",
    later.from === "2026-08-20" && later.days === 8, `${later.days} days`);
  const afterTheTrip = ask("", "2026-09-10");
  check("once the default trip is past, its date is refused rather than back-dated",
    afterTheTrip.error != null, afterTheTrip.error);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
