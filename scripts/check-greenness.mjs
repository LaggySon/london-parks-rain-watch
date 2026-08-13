/**
 * Behavioural checks for lib/greenness.mjs.
 *
 * The project has no test framework and needs no dependencies for this: the model is pure,
 * so synthetic weather is enough to pin down the properties that matter. Each check names
 * the source whose published figure it encodes, so a failure means either a coding mistake
 * or a genuine disagreement with the agronomy literature - both worth knowing about.
 *
 *   node scripts/check-greenness.mjs
 */

import {
  MODEL, PARKS, SOILS, runPark, profile, partitionRain, soilIntake, depletionFraction,
  growthFactor, recoveryCeiling, rainNeeded, sitVerdict, deliveryPlans, satisfyingCases,
} from "../lib/greenness.mjs";

let failures = 0;

function check(name, condition, detail) {
  if (!condition) failures++;
  console.log(`${condition ? "  ok  " : " FAIL "} ${name}${detail ? `  ${detail}` : ""}`);
}

/** Build `count` identical days. */
function days(count, { mm = 0, et0 = 4.5, tmax = 24, tmean = 18 } = {}) {
  return Array.from({ length: count }, (_, i) => ({ date: `d${i}`, mm, et0, tmax, tmean }));
}

const park = PARKS.hyde;
const { taw, shallowCap, deepCap } = profile(park);
/** Spin-up start: a wet spring root zone. */
const wet = { shallowAvailable: 0.85, deepAvailable: 0.85 };
const gEnd = (run) => run.series[run.series.length - 1].greenness;

console.log("\n--- soil profile (FAO-56 Tables 19/22, MORECS two-reservoir split)");
{
  check("available water is plausible for a 0.4m amenity turf root zone",
    taw > 40 && taw < 80, `taw=${taw.toFixed(1)}mm`);
  check("the profile splits 40/60 as MORECS does",
    Math.abs(shallowCap / taw - 0.4) < 1e-9 && Math.abs(shallowCap + deepCap - taw) < 1e-9,
    `shallow=${shallowCap.toFixed(1)}mm deep=${deepCap.toFixed(1)}mm`);
  check("Greenwich holds least water of the five parks",
    Object.values(PARKS).every((p) => p.key === "greenwich" || profile(p).taw > profile(PARKS.greenwich).taw),
    `greenwich=${profile(PARKS.greenwich).taw.toFixed(1)}mm hyde=${taw.toFixed(1)}mm`);
  check("depletion fraction is FAO-56's 0.40 for turf at ET0 5mm/day",
    Math.abs(depletionFraction(5, SOILS.loam) - 0.40) < 1e-9,
    `p=${depletionFraction(5, SOILS.loam).toFixed(3)}`);
  check("stress starts later when demand is low (FAO-56 p adjustment)",
    depletionFraction(2, SOILS.loam) > depletionFraction(5, SOILS.loam),
    `p(ET0=2)=${depletionFraction(2, SOILS.loam).toFixed(2)} p(ET0=5)=${depletionFraction(5, SOILS.loam).toFixed(2)}`);
}

console.log("\n--- canopy interception (Kruse et al., PLOS ONE 2022: 4.4mm threshold, 0.84 slope)");
{
  check("a 4mm day puts nothing at all into the soil",
    partitionRain(4, 0).throughfall === 0);
  check("throughfall begins just past 4.4mm",
    partitionRain(5, 0).throughfall > 0 && partitionRain(5, 0).throughfall < 1,
    `throughfall=${partitionRain(5, 0).throughfall.toFixed(2)}mm`);
  check("16% of each additional mm is intercepted",
    Math.abs(partitionRain(24.4, 0).throughfall - 20 * 0.84) < 1e-9,
    `20mm past the threshold -> ${partitionRain(24.4, 0).throughfall.toFixed(2)}mm`);
  check("an already-wet canopy passes rain on much more efficiently",
    partitionRain(5, MODEL.CANOPY_CAPACITY_MM).throughfall > partitionRain(5, 0).throughfall,
    `wet=${partitionRain(5, MODEL.CANOPY_CAPACITY_MM).throughfall.toFixed(2)}mm dry=${partitionRain(5, 0).throughfall.toFixed(2)}mm`);
  check("dry ground absorbs less of what gets through than wet ground",
    soilIntake(10, shallowCap * 0.95, shallowCap) < soilIntake(10, shallowCap * 0.05, shallowCap),
    `dry=${soilIntake(10, shallowCap * 0.95, shallowCap).toFixed(2)}mm wet=${soilIntake(10, shallowCap * 0.05, shallowCap).toFixed(2)}mm`);
}

console.log("\n--- drizzle vs one decent fall: the same total, very different outcome");
{
  const start = { ...wet };
  const drizzle = runPark(park, days(15, { mm: 1.0, et0: 3.0, tmax: 24, tmean: 18 }), start);
  const oneFall = days(15, { mm: 0, et0: 3.0, tmax: 24, tmean: 18 });
  oneFall[0].mm = 15;
  const single = runPark(park, oneFall, start);
  check("15mm as daily drizzle beats nothing by less than one 15mm fall does",
    gEnd(single) > gEnd(drizzle),
    `drizzle=${gEnd(drizzle).toFixed(3)} single=${gEnd(single).toFixed(3)}`);
  check("sub-threshold drizzle never wets the soil at all",
    days(20, { mm: 2 }).reduce((c, d) => partitionRain(d.mm, 0).throughfall + c, 0) === 0);
}

console.log("\n--- growth temperature response (Beard 1973: shoot optimum 15.5-24C)");
{
  check("no growth at 5C", growthFactor(5) === 0);
  check("full growth across 16-24C", growthFactor(16) > 0.9 && growthFactor(24) === 1);
  check("growth stops by 35C", growthFactor(35) === 0);
}

console.log("\n--- recovery ceiling (UMass: 45-60+ dormant days -> only ~70% recovery)");
{
  check("no penalty within the 4-6 week survival window",
    recoveryCeiling(28) === 1, `ceiling(28d)=${recoveryCeiling(28).toFixed(2)}`);
  check("about 70% recovery after ~52 dormant days",
    Math.abs(recoveryCeiling(52) - 0.70) < 0.02, `ceiling(52d)=${recoveryCeiling(52).toFixed(2)}`);
  check("ceiling never falls below the surviving-crown floor",
    recoveryCeiling(400) === MODEL.MORTALITY_FLOOR, `ceiling(400d)=${recoveryCeiling(400).toFixed(2)}`);
}

console.log("\n--- 1. a long hot drought turns the park brown");
const drought = runPark(park, days(92, { mm: 0, et0: 4.8, tmax: 28, tmean: 21 }), wet);
const droughtStart = { natural: drought.natural, irrigated: drought.irrigated };
{
  const end = drought.series[drought.series.length - 1];
  check("greenness collapses", end.greenness < 0.15, `greenness=${end.greenness.toFixed(3)}`);
  check("root zone is empty", end.dryness > 0.9, `dryness=${end.dryness.toFixed(3)}`);
  check("sitting on it is unpleasant", end.sit < 0.4, `sit=${end.sit.toFixed(3)}`);
  check("the verdict says hard-baked",
    sitVerdict(end.sit, end.dryness, end.greenness).detail.includes("baked"),
    JSON.stringify(sitVerdict(end.sit, end.dryness, end.greenness)));
  check("watered pockets stay greener than unwatered",
    end.irrigatedGreenness > end.naturalGreenness + 0.2,
    `watered=${end.irrigatedGreenness.toFixed(2)} unwatered=${end.naturalGreenness.toFixed(2)}`);
  check("recovery potential is spent", end.ceiling <= MODEL.MORTALITY_FLOOR + 1e-9,
    `ceiling=${end.ceiling.toFixed(2)} dormantDays=${end.dormantDays.toFixed(0)}`);
}

console.log("\n--- 2. rain the day before arrival is worth almost nothing (the lag)");
{
  const quiet = runPark(park, days(15, { mm: 0, et0: 3.5, tmax: 23, tmean: 18 }), droughtStart);

  const lateDays = days(15, { mm: 0, et0: 3.5, tmax: 23, tmean: 18 });
  lateDays[14].mm = 8;
  const late = runPark(park, lateDays, droughtStart);

  const earlyDays = days(15, { mm: 0, et0: 3.5, tmax: 23, tmean: 18 });
  earlyDays[0].mm = 8;
  const early = runPark(park, earlyDays, droughtStart);

  check("8mm on the final day barely moves greenness", Math.abs(gEnd(late) - gEnd(quiet)) < 0.02,
    `quiet=${gEnd(quiet).toFixed(4)} late=${gEnd(late).toFixed(4)}`);
  check("the same 8mm two weeks earlier does more", gEnd(early) > gEnd(late),
    `early=${gEnd(early).toFixed(4)} late=${gEnd(late).toFixed(4)}`);
}

console.log("\n--- 3. published watering rates behave as published");
{
  // UMass: "Most turfgrass species require 1 to 1.5 inches of water per week" (25-38mm).
  // Iowa State: ~1 inch a week prevents dormancy; 1/4 inch a week keeps crowns alive but
  // "won't restore color".
  const mild = { et0: 2.5, tmax: 20, tmean: 16 };
  const anInch = runPark(park, days(42, { mm: 25 / 7, ...mild }), wet);
  const aQuarter = runPark(park, days(42, { mm: 6 / 7, ...mild }), wet);
  check("1 inch/week keeps a healthy park out of dormancy",
    gEnd(anInch) >= MODEL.GREEN_THRESHOLD, `greenness=${gEnd(anInch).toFixed(3)}`);
  check("1/4 inch/week does not keep it green",
    gEnd(aQuarter) < MODEL.GREEN_THRESHOLD, `greenness=${gEnd(aQuarter).toFixed(3)}`);
  check("...and the difference between them is large",
    gEnd(anInch) - gEnd(aQuarter) > 0.3,
    `inch=${gEnd(anInch).toFixed(3)} quarter=${gEnd(aQuarter).toFixed(3)}`);
}

console.log("\n--- 4. green-up after a short dry spell (UMass: '2 weeks or more')");
{
  const shortDry = runPark(park, days(30, { mm: 0, et0: 4.2, tmax: 26, tmean: 20 }), wet);
  const from = { natural: shortDry.natural, irrigated: shortDry.irrigated };
  check("30 dry days is enough to brown it",
    gEnd(shortDry) < 0.25, `greenness=${gEnd(shortDry).toFixed(3)}`);
  check("...but recovery potential is still intact",
    shortDry.series[29].ceiling > 0.95, `ceiling=${shortDry.series[29].ceiling.toFixed(2)}`);

  // Iowa State forced green-up: 1-1.5 inches at once, watered again 7 days later.
  const forced = days(21, { mm: 0, et0: 2.5, tmax: 20, tmean: 16 });
  forced[0].mm = 32; forced[7].mm = 32; forced[14].mm = 32;
  const revived = runPark(park, forced, from);
  check("three soakings a week apart bring it back past 'noticeably green'",
    gEnd(revived) >= MODEL.GREEN_THRESHOLD, `greenness=${gEnd(revived).toFixed(3)}`);
  check("colour is visibly returning within about a week, not instantly",
    revived.series[2].greenness < revived.series[9].greenness
      && revived.series[9].greenness > gEnd(shortDry) + 0.1,
    `day3=${revived.series[2].greenness.toFixed(3)} day10=${revived.series[9].greenness.toFixed(3)}`);
}

console.log("\n--- 5. green-up after a 3-month drought is real but capped (UMass ~70%)");
{
  const mild = { et0: 2.5, tmax: 20, tmean: 16 };
  const recovery = runPark(park, days(21, { mm: 32 / 7, ...mild }), droughtStart);
  const end = recovery.series[20];
  check("three weeks of steady rain lifts it well clear of dormancy",
    end.greenness > gEnd(drought) + 0.15,
    `after=${end.greenness.toFixed(3)} before=${gEnd(drought).toFixed(3)}`);
  check("but it cannot reach full lushness - part of the sward is dead",
    end.greenness < 0.7, `greenness=${end.greenness.toFixed(3)}`);
  check("recovery is gradual, not a step",
    recovery.series[3].greenness < recovery.series[13].greenness,
    `day4=${recovery.series[3].greenness.toFixed(3)} day14=${recovery.series[13].greenness.toFixed(3)}`);
}

console.log("\n--- 6. one downpour is worth less than the same total spread out");
{
  const burst = days(20, { mm: 0, et0: 3.2, tmax: 22, tmean: 17 });
  burst[0].mm = 100;
  const spread = days(20, { mm: 5, et0: 3.2, tmax: 22, tmean: 17 });
  const gBurst = gEnd(runPark(park, burst, droughtStart));
  const gSpread = gEnd(runPark(park, spread, droughtStart));
  check("100mm in one day beats nothing", gBurst > gEnd(drought),
    `burst=${gBurst.toFixed(3)} drought=${gEnd(drought).toFixed(3)}`);
  check("100mm over 20 days beats 100mm in one day", gSpread > gBurst,
    `spread=${gSpread.toFixed(3)} burst=${gBurst.toFixed(3)}`);
}

console.log("\n--- 7. park differences behave sensibly");
{
  const hot = days(60, { mm: 0.3, et0: 4.8, tmax: 29, tmean: 22 });
  const results = Object.values(PARKS).map((p) => ({
    name: p.name, g: gEnd(runPark(p, hot, wet)),
  }));
  for (const r of results) console.log(`       ${r.name.padEnd(20)} ${r.g.toFixed(3)}`);
  const g = (prefix) => results.find((r) => r.name.startsWith(prefix)).g;
  check("Greenwich (thin stony soil, unwatered) browns most",
    results.every((r) => r.name.startsWith("Greenwich") || r.g >= g("Greenwich")),
    `greenwich=${g("Greenwich").toFixed(3)}`);
  check("St James's (widest irrigation) holds on best",
    results.every((r) => r.name.startsWith("St James") || r.g <= g("St James")),
    `stJames=${g("St James").toFixed(3)}`);
}

console.log("\n--- 8. a hosepipe ban removes the watered-lawn advantage");
{
  const hot = days(60, { mm: 0.3, et0: 4.8, tmax: 29, tmean: 22 });
  const free = runPark(PARKS["st-james"], hot, { ...wet, restricted: false });
  const banned = runPark(PARKS["st-james"], hot, { ...wet, restricted: true });
  check("St James's is browner under a Temporary Use Ban", gEnd(banned) < gEnd(free),
    `unrestricted=${gEnd(free).toFixed(3)} banned=${gEnd(banned).toFixed(3)}`);
  check("the effective watered share shrinks but is not zero",
    banned.series[59].irrigatedFraction > 0
      && banned.series[59].irrigatedFraction < free.series[59].irrigatedFraction,
    `banned=${banned.series[59].irrigatedFraction.toFixed(3)} free=${free.series[59].irrigatedFraction.toFixed(3)}`);
}

console.log("\n--- 9. 'what would it take' is answerable and ordered");
{
  const short = rainNeeded(park, droughtStart, days(15, { et0: 3.5, tmax: 23, tmean: 18 }));
  const long = rainNeeded(park, droughtStart, days(40, { et0: 3.5, tmax: 23, tmean: 18 }));
  console.log(`       15 days -> ${JSON.stringify(short)}`);
  console.log(`       40 days -> ${JSON.stringify(long)}`);
  check("a longer window needs a lower daily rate", long.reachable
    && (!short.reachable || long.perDayMm <= short.perDayMm),
    `short=${short.perDayMm?.toFixed(2)}mm/day long=${long.perDayMm?.toFixed(2)}mm/day`);
}

console.log("\n--- 10. what it would take to be good to sit on");
{
  const window15 = days(15, { et0: 3.5, tmax: 23, tmean: 18 });

  // Uniform daily rain over a long window is the one case where the sit bar costs *more*
  // millimetres than the colour bar: holding the soil near capacity for weeks is what makes
  // grass green and ground soft at the same time, so the mud term eats the head start that
  // the sit bar's lower cover requirement gives it.
  const mild = days(60, { et0: 2.5, tmax: 20, tmean: 16 });
  const longSit = rainNeeded(park, droughtStart, mild, MODEL.SIT_THRESHOLD, "sit");
  const longGreen = rainNeeded(park, droughtStart, mild);
  check("weeks of daily rain soften the ground as fast as they green the grass",
    longSit.reachable && longGreen.reachable && longSit.extraMm >= longGreen.extraMm,
    `sit=${longSit.extraMm}mm green=${longGreen.extraMm}mm`);
  check("both bars are asked of the same metric they describe",
    MODEL.SIT_THRESHOLD > MODEL.SIT_MARGINAL_THRESHOLD
      && sitVerdict(MODEL.SIT_THRESHOLD, 0.5, 0.4).verdict === "Yes"
      && sitVerdict(MODEL.SIT_THRESHOLD - 0.01, 0.5, 0.4).verdict === "Just about"
      && sitVerdict(MODEL.SIT_MARGINAL_THRESHOLD - 0.01, 0.5, 0.4).verdict === "No");

  const plans = deliveryPlans(window15);
  check("the delivery patterns run from spread out to a single late fall",
    plans[0].falls === 15 && plans[plans.length - 1].falls === 1
      && plans[plans.length - 1].onDays[0] === 15,
    plans.map((p) => `${p.key}:${p.falls}`).join(" "));
  check("every pattern delivers exactly the total it was asked for",
    plans.every((p) => Math.abs(p.build(60).reduce((sum, d) => sum + d.mm, 0) - 60) < 1e-9));

  const cases = satisfyingCases(park, droughtStart, window15);
  for (const c of cases) {
    console.log(`       ${c.label.padEnd(38)} ${c.reachable ? `${c.extraMm}mm` : "never"}`
      + `  peak sit ${c.peakSit.toFixed(3)} @ ${c.peakMm}mm`);
  }
  check("there is one case per delivery pattern", cases.length === plans.length);
  check("a park can be pleasant to sit on while still not looking green",
    cases.some((c) => c.reachable && c.greenness < MODEL.GREEN_THRESHOLD),
    cases.filter((c) => c.reachable)
      .map((c) => `${c.key}: sit ${c.sit.toFixed(2)} green ${c.greenness.toFixed(2)}`).join(" | "));
  check("no pattern reports a total it cannot back up",
    cases.every((c) => (c.reachable
      ? c.sit >= MODEL.SIT_THRESHOLD && c.extraMm != null
      : c.sit == null && c.peakSit < MODEL.SIT_THRESHOLD)));
  check("a pattern's peak is at least as good as its crossing point",
    cases.every((c) => !c.reachable || c.peakSit >= c.sit - 1e-9));
  check("rain the day before arrival is the weakest way to deliver it",
    cases.find((c) => c.key === "eve").peakSit
      < Math.max(...cases.filter((c) => c.key !== "eve").map((c) => c.peakSit)),
    `eve=${cases.find((c) => c.key === "eve").peakSit.toFixed(3)}`);
  check("concentrating the rain into a few soakings beats drizzling it out",
    cases.find((c) => c.key === "two").peakSit > cases.find((c) => c.key === "spread").peakSit,
    `two=${cases.find((c) => c.key === "two").peakSit.toFixed(3)} `
    + `spread=${cases.find((c) => c.key === "spread").peakSit.toFixed(3)}`);
  check("past each pattern's peak, more rain stops helping",
    cases.every((c) => c.peakMm < MODEL.MAX_EXTRA_MM),
    cases.map((c) => `${c.key}:${c.peakMm}mm`).join(" "));
  check("after a three-month drought the sit bar needs real weather, not a shower",
    cases.every((c) => !c.reachable || c.extraMm > 20),
    cases.filter((c) => c.reachable).map((c) => `${c.key}:${c.extraMm}mm`).join(" ") || "none reachable");
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
