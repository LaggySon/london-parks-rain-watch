/**
 * Turf greenness model for the London parks dashboard.
 *
 * Rainfall totals say very little about whether a park looks green. Three effects
 * dominate, and none of them is visible in a millimetre total:
 *
 *   1. **Interception.** A turf canopy holds several millimetres of rain before *any*
 *      of it reaches the soil. Measured on mown turf, throughfall does not begin until
 *      4.4 mm has fallen, and 16% of every additional millimetre is lost after that.
 *      Most UK rain days are 2-3 mm, so they wet the soil not at all. This is the single
 *      biggest reason a "18 mm forecast" can leave the grass completely unchanged.
 *   2. **Water balance, not rainfall.** What matters is rain minus evaporative demand
 *      (ET0), and where in the profile the water ends up. Grass greens from the top down,
 *      because the crowns and most fine roots sit in the shallow layer, which rewets in
 *      days while the deeper profile can stay empty for months.
 *   3. **Lag and asymmetry.** Turf browns within 2-4 weeks of drought but needs two weeks
 *      or more of sustained moisture to green up again. Rain landing the day before
 *      arrival is worth almost nothing visually.
 *
 * Above that sits dormancy and mortality: cool-season turf survives roughly 4-6 weeks of
 * dormancy intact, but after 45-60+ days of drought part of the sward is dead rather than
 * dormant and only about 70% recovery is possible, so short-term green-up is capped.
 *
 * ## Provenance of every constant
 *
 * The values below are sourced rather than guessed. Where a number could not be found in
 * the literature it is marked UNCALIBRATED, and those are the ones to distrust.
 *
 * - **FAO-56** (Allen et al., FAO Irrigation & Drainage Paper 56) Table 12 for the crop
 *   coefficient, Table 19 for soil water characteristics, Table 22 for rooting depth and
 *   the depletion fraction p, and the p = p_table + 0.04(5 - ETc) adjustment.
 * - **MORECS** (Met Office Rainfall and Evaporation Calculation System), the Met Office's
 *   operational UK grassland water-balance model, splits available soil water into two
 *   reservoirs holding 40% and 60%, with surface resistance constant while the first 40%
 *   is extracted. That independently corroborates both the two-layer structure here and
 *   FAO-56's p = 0.40 for cool-season turf.
 * - **Interception:** Kruse et al., "Measuring turfgrass canopy interception and
 *   throughfall using co-located pluviometers", PLOS ONE 17(9) e0271236, 2022.
 * - **Dormancy and recovery:** UMass Extension (Ebdon), "Management Tips to Improve
 *   Turfgrass Drought Survival"; Iowa State Extension, "Summer Dormancy in Cool-Season
 *   Lawns"; University of Nebraska-Lincoln Extension via secondary citation.
 * - **Growth temperature optima:** Beard (1973), cited in Huang, *Turfgrass Trends*, 2000.
 *
 * Deliberately free of I/O so it can be exercised directly by scripts/check-greenness.mjs.
 */

export const MODEL = {
  // --- evaporative demand -------------------------------------------------------------
  /**
   * Crop coefficient for amenity turf. FAO-56 Table 12 gives Kc_mid = 0.95 for cool-season
   * turf (bluegrass/ryegrass/fescue) at 60-80 mm mowing height, and states it "can be
   * reduced by 0.10" where water is managed carefully and rapid growth is not wanted -
   * which describes public parkland.
   */
  KC: 0.85,
  /**
   * FAO-56 Table 22 depletion fraction for cool-season turf grass: stress begins once this
   * share of available water is gone. Note this is 0.40, not the 0.50 general default -
   * turf starts suffering while the soil is still comparatively moist. MORECS uses the
   * same 40% for its first reservoir.
   */
  P_BASE: 0.40,
  /** FAO-56: p = p_table + 0.04 (5 - ETc), ETc in mm/day, result clamped to 0.1-0.8. */
  P_ET_SLOPE: 0.04,
  P_MIN: 0.1,
  P_MAX: 0.8,

  // --- profile structure --------------------------------------------------------------
  /** MORECS reservoir X: the first 40% of available water, held nearest the surface. */
  SHALLOW_SHARE: 0.40,
  /**
   * Share of transpiration drawn from the shallow layer while it still holds water.
   * UNCALIBRATED - a judgement that most fine root activity is shallow, with the plant
   * leaning on depth once the surface is exhausted.
   */
  SHALLOW_ET_SHARE: 0.7,

  // --- interception (Kruse et al. 2022, measured on mown turf) ------------------------
  /**
   * Rain held by the canopy before throughfall begins: 4.4 mm (95% CI 3.6-5.3), the
   * x-intercept of a precipitation-throughfall regression with r = 0.98 across 15 storms.
   * "No precipitation reaches the soil surface for precipitation events < 4.4 mm."
   * Full submersion capacity is ~9 mm, so drainage starts at roughly half saturation.
   */
  CANOPY_CAPACITY_MM: 4.4,
  /**
   * Regression slope: once throughfall starts, 84% of each further millimetre gets
   * through and 16% is intercepted.
   */
  THROUGHFALL_SLOPE: 0.84,

  // --- infiltration -------------------------------------------------------------------
  /**
   * Daily infiltration ceiling; beyond this an intense fall mostly runs off.
   * UNCALIBRATED for London park soils.
   */
  DAILY_SOAK_CAP_MM: 25,
  /** Share of the above-cap excess that still finds its way in. UNCALIBRATED. */
  EXCESS_SOAK_FRACTION: 0.15,
  /**
   * Infiltration efficiency into bone-dry, hydrophobic turf soil. Soil water repellency
   * below a critical water content is well established (it drives localised dry spot, and
   * measured critical moisture contents sit inside the wilting range), and it demonstrably
   * increases runoff - but no defensible percentage for amenity grassland was found, so
   * this is deliberately a mild penalty. UNCALIBRATED.
   */
  DRY_SOIL_INFILTRATION: 0.7,

  // --- greenness dynamics -------------------------------------------------------------
  /**
   * Browning time constant. UMass: turf "stops growing and turns straw-colored" after
   * "prolonged periods (2 to 4 weeks) of little or no water", which a 7-day constant
   * reproduces (~90% of the way down in 16 days).
   */
  TAU_BROWN_DAYS: 7,
  /**
   * Greening time constant at optimum growing temperature. UMass: recovery "may take 2
   * weeks or more before 100% green-up is obtained". Iowa State's forced green-up (25-38 mm,
   * repeated after 7 days) reports colour returning after the second watering. A 10-day
   * constant gives visible change in about a week and near-complete green-up in three.
   */
  TAU_GREEN_DAYS: 10,
  /**
   * Shallow-layer relative water below which no regrowth happens at all: the crown layer
   * has to actually rewet first. UNCALIBRATED.
   */
  REWET_RAW: 0.30,
  /** Weight of the shallow layer in the greenness the eye sees. UNCALIBRATED. */
  SHALLOW_GREEN_WEIGHT: 0.65,
  /** Relative available water at or below which turf is fully brown. UNCALIBRATED. */
  GREEN_FLOOR_RAW: 0.10,
  /** Relative available water at or above which turf is fully green. UNCALIBRATED. */
  GREEN_FULL_RAW: 0.55,

  // --- dormancy and mortality ---------------------------------------------------------
  /**
   * Dormant days survived with no loss of recovery potential. Iowa State: cool-season
   * grasses "can typically hold on for 4 to 6 weeks without suffering significant damage";
   * Nebraska: "4 to 5 weeks, but only 3 to 4 weeks if temperatures remain above 80F".
   */
  DORMANCY_GRACE_DAYS: 30,
  /**
   * Loss of achievable greenness per dormant day past the grace period, fitted to UMass:
   * after "45 to 60+ days" of dormancy "only 70% recovery may be possible".
   * 30 days -> ceiling 1.00; 52 days -> ceiling 0.70.
   */
  MORTALITY_SLOPE_PER_DAY: 0.0136,
  /**
   * Floor on achievable greenness however long the drought. Surviving crowns, seed in the
   * soil and opportunist weeds still produce substantial green cover; drought studies
   * report cool-season turf recovering after 60-83 day dry-downs. UNCALIBRATED.
   */
  MORTALITY_FLOOR: 0.50,
  /** Above this daily maximum, dormancy costs the sward more (Nebraska's 80F = 26.7C). */
  DORMANCY_HEAT_C: 27,
  /** Cap on the heat multiplier, so one extreme day cannot dominate. */
  MORTALITY_DAILY_CAP: 1.6,
  /**
   * How fast recovery potential returns once conditions are good again, as the sward
   * knits back together. UNCALIBRATED.
   */
  MORTALITY_RECOVERY_PER_DAY: 0.8,

  // --- reporting thresholds -----------------------------------------------------------
  /** Greenness at or above which a park reads as "noticeably green" to a visitor. */
  GREEN_THRESHOLD: 0.45,
  /**
   * Sit score at or above which `sitVerdict` says "Yes" rather than "Just about". Kept here
   * so the "what would it take" search aims at exactly the bar the words describe.
   *
   * Note this bar sits *below* GREEN_THRESHOLD in effect: a park can be comfortable to sit
   * on while still reading as patchy, because thin green cover over damp soil is pleasant
   * to sit on and unimpressive to look at.
   */
  SIT_THRESHOLD: 0.6,
  /** ...and the lower bar, where sitting on it is merely tolerable. */
  SIT_MARGINAL_THRESHOLD: 0.4,
  /**
   * Ceiling for the "what would it take" searches, mm of extra rain. Around three months of
   * London's average rainfall - past this the question has stopped being about weather.
   */
  MAX_EXTRA_MM: 400,

  // --- irrigation ---------------------------------------------------------------------
  /** Watered areas get water once shallow depletion passes this fraction... */
  IRRIGATION_TRIGGER: 0.5,
  /** ...and are topped back up to this fraction of the shallow layer. */
  IRRIGATION_TARGET: 0.15,
  /**
   * Share of normal irrigation that survives a Temporary Use Ban. Thames Water's ban
   * prohibits hosepipes and sprinklers on lawns and gardens, with exemptions only for
   * food crops and certain newly planted trees - amenity turf is not exempt. Watering cans
   * and non-mains sources stay legal, and some Royal Parks hold their own abstraction, so
   * a small residual remains. UNCALIBRATED, and the single most uncertain input here.
   */
  RESTRICTED_IRRIGATION_RESIDUAL: 0.15,
};

/**
 * Soil water characteristics, FAO-56 Table 19 (midpoints of the printed ranges).
 * `awc` is available water in mm per metre of depth, i.e. 1000 (thetaFc - thetaWp).
 */
export const SOILS = {
  loam: { label: "loam", thetaFc: 0.25, thetaWp: 0.12, awc: 155, pAdjust: 0 },
  clayLoam: { label: "clay loam", thetaFc: 0.335, thetaWp: 0.205, awc: 155, pAdjust: -0.05 },
  sandyLoam: { label: "sandy loam", thetaFc: 0.23, thetaWp: 0.11, awc: 130, pAdjust: 0.05 },
  loamySand: { label: "loamy sand", thetaFc: 0.15, thetaWp: 0.065, awc: 90, pAdjust: 0.05 },
};

/**
 * Per-park parameters.
 *
 * `rootDepthM` is the *effective* turf root zone. FAO-56 Table 22 gives 0.5-1.0 m for
 * cool-season turf, but that assumes deep unrestricted rooting; mown amenity grass on
 * compacted, trafficked London parkland roots far shallower, so these sit at 0.30-0.42 m.
 * `stones` reduces available water for stony ground. `exposure` is an ET0 multiplier for
 * aspect and wind, `shade` the share of tree cover reducing evaporative demand,
 * `irrigatedFraction` the share of visible lawn watered in an unrestricted year.
 *
 * **These are documented assumptions, not fetched data.** Soil type, effective root depth
 * and irrigation coverage are not published per park, so they are reasoned from geology
 * and from how each park is managed. They are the weakest link in the chain and are
 * labelled as such in the UI.
 */
export const PARKS = {
  hyde: {
    key: "hyde",
    name: "Hyde Park",
    soil: "loam",
    // Broad open lawns on brickearth/loam over London Clay; only formal areas watered.
    rootDepthM: 0.40, stones: 0.05,
    irrigatedFraction: 0.12, exposure: 1.0, shade: 0.25,
    note: "open loam over London Clay, heavily trafficked",
  },
  "st-james": {
    key: "st-james",
    name: "St James’s Park",
    soil: "loam",
    // Small, intensively managed showpiece lawns; deepest topsoil, widest irrigation.
    rootDepthM: 0.42, stones: 0.02,
    irrigatedFraction: 0.45, exposure: 0.95, shade: 0.35,
    note: "improved loam, high organic matter, showpiece lawns",
  },
  regent: {
    key: "regent",
    name: "Regent’s Park",
    soil: "clayLoam",
    // Heavier soil holds more but releases it less readily; sports turf unwatered.
    rootDepthM: 0.40, stones: 0.03,
    irrigatedFraction: 0.22, exposure: 1.0, shade: 0.30,
    note: "clay loam, large unwatered sports pitches",
  },
  kensington: {
    key: "kensington",
    name: "Kensington Gardens",
    soil: "loam",
    // Formal avenues and lawns; moderate irrigation near the palace and Round Pond.
    rootDepthM: 0.38, stones: 0.05,
    irrigatedFraction: 0.30, exposure: 0.95, shade: 0.35,
    note: "loam over London Clay, formal lawns",
  },
  greenwich: {
    key: "greenwich",
    name: "Greenwich Park",
    soil: "sandyLoam",
    // Thin stony soil over the Blackheath Pebble Beds on an exposed south-facing hill:
    // dries first, holds least, effectively unirrigated. Browns before the others.
    rootDepthM: 0.30, stones: 0.25,
    irrigatedFraction: 0.05, exposure: 1.12, shade: 0.28,
    note: "thin stony soil over sand and gravel, exposed south slope",
  },
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const clamp01 = (value) => clamp(value, 0, 1);

/**
 * Derived soil physics for a park: total available water and the two reservoir capacities.
 * TAW = root depth x available water per metre x (1 - stone fraction).
 */
export function profile(park) {
  const soil = SOILS[park.soil];
  const taw = park.rootDepthM * soil.awc * (1 - park.stones);
  return {
    soil,
    taw,
    shallowCap: taw * MODEL.SHALLOW_SHARE,
    deepCap: taw * (1 - MODEL.SHALLOW_SHARE),
    thetaFc: soil.thetaFc,
    thetaWp: soil.thetaWp,
  };
}

/**
 * FAO-56 depletion fraction, adjusted for the day's evaporative demand and soil texture:
 * p = p_table + 0.04 (5 - ETc), clamped to 0.1-0.8. Stress starts earlier on hot days,
 * because the same soil water cannot be moved fast enough to meet demand.
 */
export function depletionFraction(et0, soil) {
  const demand = et0 == null ? 5 : et0;
  const p = MODEL.P_BASE + MODEL.P_ET_SLOPE * (5 - demand) + (soil ? soil.pAdjust : 0);
  return clamp(p, MODEL.P_MIN, MODEL.P_MAX);
}

/**
 * FAO-56 water stress coefficient Ks. Once readily available water is gone the grass
 * shuts down and transpires less, which is why the deficit stops growing without limit
 * however hot it gets.
 */
export function stressCoefficient(depletion, capacity, p) {
  if (capacity <= 0) return 0;
  const readily = p * capacity;
  if (depletion <= readily) return 1;
  return clamp01((capacity - depletion) / ((1 - p) * capacity));
}

/** Dry soil sheds water; a rewetted surface takes nearly all of it. */
export function infiltrationFraction(shallowDepletion, shallowCap) {
  const wetness = 1 - clamp01(shallowDepletion / shallowCap);
  return MODEL.DRY_SOIL_INFILTRATION + (1 - MODEL.DRY_SOIL_INFILTRATION) * wetness;
}

/**
 * Split a day's rain into canopy storage and throughfall (Kruse et al. 2022).
 *
 * Returns the water passing the canopy and the canopy store left behind. Because the store
 * carries over, consecutive wet days are far more efficient than the same rain spread as
 * isolated showers - each dry gap lets the canopy empty and charge its 4.4 mm toll again.
 */
export function partitionRain(mm, canopyStore) {
  const cap = MODEL.CANOPY_CAPACITY_MM;
  let canopy = canopyStore + (mm || 0);
  if (canopy <= cap) return { throughfall: 0, canopy };
  const excess = canopy - cap;
  return {
    throughfall: excess * MODEL.THROUGHFALL_SLOPE,
    canopy: cap + excess * (1 - MODEL.THROUGHFALL_SLOPE),
  };
}

/** Throughfall that actually enters the soil, after the runoff cap and repellency. */
export function soilIntake(throughfall, shallowDepletion, shallowCap) {
  const soaked = Math.min(throughfall, MODEL.DAILY_SOAK_CAP_MM);
  const excess = throughfall - soaked;
  const efficiency = infiltrationFraction(shallowDepletion, shallowCap);
  return (soaked + excess * MODEL.EXCESS_SOAK_FRACTION) * efficiency;
}

/**
 * Cool-season grass growth response to mean temperature. Beard (1973): shoot growth
 * optimum 60-75 F (15.5-24 C); growth ceases near freezing and effectively stops in
 * extreme heat.
 */
export function growthFactor(tmean) {
  const t = tmean == null ? 15 : tmean;
  if (t <= 5) return 0;
  if (t < 15.5) return (t - 5) / 10.5;
  if (t <= 24) return 1;
  if (t >= 35) return 0;
  return Math.max(0, 1 - (t - 24) / 11);
}

/**
 * Heat penalty on dormancy survival. Nebraska: cool-season turf survives dormancy 4-5
 * weeks, "but only 3 to 4 weeks if temperatures remain above 80F" (26.7 C) - a ratio of
 * about 1.3, extended mildly for extreme heat.
 */
export function heatFactor(tmax) {
  const t = tmax == null ? 20 : tmax;
  if (t <= MODEL.DORMANCY_HEAT_C) return 1;
  return Math.min(MODEL.MORTALITY_DAILY_CAP, 1 + (t - MODEL.DORMANCY_HEAT_C) / 15);
}

/**
 * Convert measured volumetric soil moisture into a fraction of available water, using the
 * park's FAO-56 texture class. Reanalysis soil moisture carries its own soil assumptions,
 * so treat this as an anchor and a cross-check, not ground truth.
 */
export function availableFractionFromTheta(park, theta) {
  const { thetaFc, thetaWp } = profile(park);
  const span = thetaFc - thetaWp;
  if (!(span > 0) || theta == null) return 0;
  return clamp01((theta - thetaWp) / span);
}

/** Relative available water, per layer and blended as the eye sees it. */
export function relativeWater(state, park) {
  const { shallowCap, deepCap } = profile(park);
  const shallow = 1 - clamp01(state.shallow / shallowCap);
  const deep = 1 - clamp01(state.deep / deepCap);
  const w = MODEL.SHALLOW_GREEN_WEIGHT;
  return { shallow, deep, blended: w * shallow + (1 - w) * deep };
}

/** Achievable greenness given accumulated dormancy: the sward mortality ceiling. */
export function recoveryCeiling(dormantDays) {
  const over = Math.max(0, dormantDays - MODEL.DORMANCY_GRACE_DAYS);
  return clamp(1 - over * MODEL.MORTALITY_SLOPE_PER_DAY, MODEL.MORTALITY_FLOOR, 1);
}

/** Greenness the sward would settle at for a given moisture state. */
export function greennessTarget(blendedRaw, ceiling = 1) {
  const span = MODEL.GREEN_FULL_RAW - MODEL.GREEN_FLOOR_RAW;
  return Math.min(clamp01((blendedRaw - MODEL.GREEN_FLOOR_RAW) / span), ceiling);
}

/**
 * @param {object} park
 * @param {number} shallowAvailable 1 = shallow layer at field capacity, 0 = empty
 * @param {number} [deepAvailable] defaults to the shallow value
 */
export function createState(park, shallowAvailable, deepAvailable) {
  const { shallowCap, deepCap } = profile(park);
  const shallowFraction = clamp01(shallowAvailable);
  const deepFraction = clamp01(deepAvailable == null ? shallowAvailable : deepAvailable);
  const state = {
    canopy: 0,
    shallow: shallowCap * (1 - shallowFraction),
    deep: deepCap * (1 - deepFraction),
    greenness: 0,
    dormantDays: 0,
    wetSpell: 0,
    irrigationApplied: 0,
  };
  // Start greenness consistent with the moisture it is initialised at, so a spin-up
  // beginning in a wet spring does not have to climb out of zero first.
  state.greenness = greennessTarget(relativeWater(state, park).blended);
  return state;
}

/**
 * Advance one day.
 *
 * @param {object} state
 * @param {{date?: string, mm: number, et0: number, tmax?: number, tmean?: number}} day
 * @param {object} park
 * @param {boolean} irrigate treat this run as a watered area
 */
export function stepDay(state, day, park, irrigate = false) {
  const { shallowCap, deepCap, soil } = profile(park);

  // --- canopy first: most small falls never reach the ground at all
  const { throughfall, canopy: canopyAfterRain } = partitionRain(day.mm, state.canopy);
  const intake = soilIntake(throughfall, state.shallow, shallowCap);

  let shallow = state.shallow - intake;
  let deep = state.deep;
  if (shallow < 0) {
    deep = Math.max(0, deep + shallow); // surplus drains down, then past the root zone
    shallow = 0;
  }

  let irrigationApplied = state.irrigationApplied;
  if (irrigate && shallow > MODEL.IRRIGATION_TRIGGER * shallowCap) {
    const target = MODEL.IRRIGATION_TARGET * shallowCap;
    irrigationApplied += shallow - target;
    shallow = target;
  }

  // --- evaporative demand. Water sitting on the canopy evaporates at close to the
  // potential rate and *substitutes* for transpiration, so it must be subtracted from
  // demand rather than counted as a loss on top of it - otherwise wet days would be
  // charged twice and rain would look useless even when it soaks in.
  const potential = (day.et0 == null ? 3 : day.et0)
    * park.exposure * (1 - 0.25 * park.shade);
  const canopyEvap = Math.min(canopyAfterRain, potential);
  const canopy = canopyAfterRain - canopyEvap;
  const transpiration = MODEL.KC * Math.max(0, potential - canopyEvap);

  const p = depletionFraction(day.et0, soil);
  const ksShallow = stressCoefficient(shallow, shallowCap, p);
  const ksDeep = stressCoefficient(deep, deepCap, p);
  // As the surface dries the plant draws proportionally more from depth.
  const deepShare = (1 - MODEL.SHALLOW_ET_SHARE)
    + MODEL.SHALLOW_ET_SHARE * (1 - ksShallow) * 0.6;
  shallow = clamp(shallow + transpiration * MODEL.SHALLOW_ET_SHARE * ksShallow, 0, shallowCap);
  deep = clamp(deep + transpiration * deepShare * ksDeep, 0, deepCap);

  const water = relativeWater({ shallow, deep }, park);
  const growth = growthFactor(day.tmean);
  const rewetted = water.shallow > MODEL.REWET_RAW;

  // --- dormancy accounting: weeks at the bottom of the bucket kill rather than pause,
  // and heat makes it worse. Recovery potential returns once it is wet and growing.
  let dormantDays = state.dormantDays;
  if (water.blended < 0.08) {
    dormantDays += heatFactor(day.tmax);
  } else if (rewetted && growth > 0) {
    dormantDays = Math.max(0, dormantDays - MODEL.MORTALITY_RECOVERY_PER_DAY * growth);
  }
  const ceiling = recoveryCeiling(dormantDays);

  // --- greenness, with the asymmetry that makes late rain nearly worthless
  const target = greennessTarget(water.blended, ceiling);
  let greenness = state.greenness;
  if (target < greenness) {
    greenness += (target - greenness) / (MODEL.TAU_BROWN_DAYS / heatFactor(day.tmax));
  } else if (rewetted && growth > 0) {
    // No rewetting of the crown layer, or no growing warmth, means no green-up today.
    greenness += (target - greenness) / (MODEL.TAU_GREEN_DAYS / growth);
  }

  return {
    canopy,
    shallow,
    deep,
    greenness: clamp01(Math.min(greenness, ceiling)),
    dormantDays,
    wetSpell: state.wetSpell * 0.6 + (day.mm || 0),
    irrigationApplied,
  };
}

/**
 * Comfort of sitting on the grass: separate from how green it looks, because hard-baked
 * dusty ground and lush-but-waterlogged ground both score badly.
 */
export function sitScore(state, park) {
  const water = relativeWater(state, park);
  const dryness = 1 - water.blended;
  const baked = clamp01((dryness - 0.55) / 0.4);
  const muddy = clamp01((state.wetSpell - 12) / 18) * clamp01((water.blended - 0.85) / 0.15);
  return clamp01(0.35 + 0.65 * state.greenness - 0.5 * baked - 0.7 * muddy);
}

/** Turn a sit score and moisture state into words. */
export function sitVerdict(score, dryness, greenness) {
  if (score >= 0.6) return { verdict: "Yes", detail: "soft turf with decent cover" };
  if (score >= 0.4) {
    return dryness > 0.7
      ? { verdict: "Just about", detail: "firm and patchy, thin cover" }
      : { verdict: "Just about", detail: "usable but uneven cover" };
  }
  if (dryness > 0.75 && greenness < 0.3) {
    return { verdict: "No", detail: "hard-baked, dusty, mostly straw" };
  }
  if (dryness < 0.1) return { verdict: "No", detail: "soft but waterlogged" };
  return { verdict: "No", detail: "bare and worn" };
}

/**
 * Effective irrigated share, accounting for a Temporary Use Ban. A ban removes hosepipe
 * and sprinkler watering of lawns, leaving only cans and non-mains supply.
 */
export function effectiveIrrigatedFraction(park, restricted) {
  return restricted
    ? park.irrigatedFraction * MODEL.RESTRICTED_IRRIGATION_RESIDUAL
    : park.irrigatedFraction;
}

/**
 * Run a sequence of days for one park, tracking watered and unwatered areas separately
 * and blending them by the park's effective irrigated share.
 *
 * @param {object} park
 * @param {Array} days
 * @param {{natural?, irrigated?, shallowAvailable?, deepAvailable?, restricted?}} start
 */
export function runPark(park, days, start = {}) {
  let natural = start.natural
    || createState(park, start.shallowAvailable ?? 0.5, start.deepAvailable);
  let irrigated = start.irrigated
    || createState(park, start.shallowAvailable ?? 0.5, start.deepAvailable);
  const series = [];

  for (const day of days) {
    natural = stepDay(natural, day, park, false);
    irrigated = stepDay(irrigated, day, park, true);
    series.push({ date: day.date, ...combine(park, natural, irrigated, start.restricted) });
  }

  return { natural, irrigated, series };
}

/** Blend the two runs into the numbers the dashboard shows. */
export function combine(park, natural, irrigated, restricted = false) {
  const f = effectiveIrrigatedFraction(park, restricted);
  const greenness = (1 - f) * natural.greenness + f * irrigated.greenness;
  const sit = (1 - f) * sitScore(natural, park) + f * sitScore(irrigated, park);
  const dryness = 1 - ((1 - f) * relativeWater(natural, park).blended
    + f * relativeWater(irrigated, park).blended);
  return {
    greenness,
    sit,
    dryness: clamp01(dryness),
    naturalGreenness: natural.greenness,
    irrigatedGreenness: irrigated.greenness,
    dormantDays: natural.dormantDays,
    ceiling: recoveryCeiling(natural.dormantDays),
    irrigatedFraction: f,
  };
}

/** Extra rain shared out equally over every day of the window. */
export function spreadEvenly(days) {
  return (total) => days.map((day) => ({ ...day, mm: (day.mm || 0) + total / days.length }));
}

/**
 * Smallest extra rainfall, delivered by `build`, that leaves `metric` at or above
 * `threshold` on the final day. Returns null if the ceiling cannot get there, which is
 * itself the useful answer.
 *
 * Scanned upward from zero rather than bisected, deliberately: more rain is not strictly
 * better. A sit score falls again once the ground turns muddy, and a downpour on baked soil
 * partly runs off, so the *first* total that clears the bar is the honest answer - a
 * bisection would happily report some larger total that merely also clears it.
 */
export function smallestExtra(park, start, days, build, metric, threshold) {
  if (!days.length) return null;
  const reaches = (total) => {
    const series = runPark(park, build(total), start).series;
    return series[series.length - 1][metric] >= threshold;
  };
  for (let coarse = 0; coarse <= MODEL.MAX_EXTRA_MM; coarse += 5) {
    if (!reaches(coarse)) continue;
    // Walk back in from the previous step, so the figure is quotable to the millimetre
    // instead of rounded up to the nearest 5 mm.
    for (let fine = Math.max(0, coarse - 4); fine < coarse; fine += 1) {
      if (reaches(fine)) return fine;
    }
    return coarse;
  }
  return null;
}

/**
 * Smallest uniformly spread extra rainfall over `days` that would lift the park to a
 * reporting threshold - the "what would it take" figure.
 *
 * Note this is deliberately *uniform* daily rain, which the canopy toll makes an
 * inefficient way to deliver water; `perDayMm` is the more meaningful half of the answer,
 * and `satisfyingCases` shows how much less it takes when the rain arrives in fewer falls.
 */
export function rainNeeded(park, start, days, threshold = MODEL.GREEN_THRESHOLD,
  metric = "greenness") {
  if (!days.length) return { extraMm: null, perDayMm: null, reachable: false };
  const extraMm = smallestExtra(park, start, days, spreadEvenly(days), metric, threshold);
  if (extraMm == null) return { extraMm: null, perDayMm: null, reachable: false };
  return { extraMm, perDayMm: extraMm / days.length, reachable: true };
}

/**
 * Named ways the same total could arrive. Delivery matters as much as the total: the canopy
 * charges its interception toll on every separate fall, and green-up needs days to run, so
 * a fortnight of drizzle and one soaking are not the same weather at all.
 *
 * Offsets are counted back from arrival, because what matters is how long the grass has to
 * use the water rather than the calendar date it lands on.
 */
export function deliveryPlans(days) {
  const n = days.length;
  if (!n) return [];
  const plan = (key, label, fromEnd) => {
    const indices = [...new Set(fromEnd.map((back) => clamp(n - 1 - back, 0, n - 1)))]
      .sort((a, b) => a - b);
    return {
      key,
      label,
      falls: indices.length,
      /** Which days of the window carry the rain, 1-based, so the UI can say when. */
      onDays: indices.map((i) => i + 1),
      build: (total) => days.map((day, i) => (indices.includes(i)
        ? { ...day, mm: (day.mm || 0) + total / indices.length } : { ...day })),
    };
  };
  return [
    {
      key: "spread",
      label: "a little every day",
      falls: n,
      onDays: null,
      build: spreadEvenly(days),
    },
    plan("three", "three soakings, five days apart", [n - 1, n - 6, n - 11]),
    plan("two", "two soakings, a week apart", [n - 1, n - 8]),
    plan("early", "one soaking, a week before you arrive", [7]),
    plan("eve", "one downpour the day before you arrive", [0]),
  ];
}

/**
 * For each delivery pattern, the smallest extra rainfall that would satisfy a threshold -
 * by default the "yes, sit on it" bar. Reported per pattern rather than as one number
 * because the totals differ by a factor of several, and that difference is the whole point:
 * the same forecast total is either useful weather or wasted weather depending on how it
 * arrives.
 *
 * Every pattern also reports its *peak* - the best the metric ever gets at any total, and
 * the total that achieves it. This matters more than it sounds. Wetter is not monotonically
 * better: past a point the ground turns muddy and the score falls again, so several patterns
 * top out just short of the bar, and after a drought deep enough to cap greenness at the
 * mortality floor even the best pattern clears it only by a hair. A bare threshold-crossing
 * total would present that near-tangency as a confident answer; the peak shows it for what
 * it is, and tells "impossible" apart from "nearly".
 */
export function satisfyingCases(park, start, days, threshold = MODEL.SIT_THRESHOLD,
  metric = "sit") {
  return deliveryPlans(days).map((plan) => {
    const at = (total) => {
      const series = runPark(park, plan.build(total), start).series;
      return series[series.length - 1];
    };
    let cleared = null;
    let peakMm = 0;
    let peak = at(0);
    for (let total = 5; total <= MODEL.MAX_EXTRA_MM; total += 5) {
      const end = at(total);
      if (end[metric] > peak[metric]) { peak = end; peakMm = total; }
      if (cleared == null && end[metric] >= threshold) cleared = total;
    }
    // Walk back in from the previous step, so the headline figure is quotable to the
    // millimetre instead of rounded up to the nearest 5 mm.
    for (let fine = Math.max(0, (cleared ?? 0) - 4); cleared && fine < cleared; fine += 1) {
      if (at(fine)[metric] >= threshold) { cleared = fine; break; }
    }
    // The state at the crossing total: a park can clear the sit bar and still look patchy,
    // so the two answers are reported side by side rather than one standing in for the other.
    const crossing = cleared == null ? null : at(cleared);
    return {
      key: plan.key,
      label: plan.label,
      falls: plan.falls,
      onDays: plan.onDays,
      reachable: cleared != null,
      extraMm: cleared,
      /** Depth of each individual fall - what a rain radar would actually show. */
      perFallMm: cleared == null ? null : cleared / plan.falls,
      sit: crossing && crossing.sit,
      greenness: crossing && crossing.greenness,
      dryness: crossing && crossing.dryness,
      peakMm,
      peakPerFallMm: peakMm / plan.falls,
      peakSit: peak.sit,
      peakGreenness: peak.greenness,
      peakDryness: peak.dryness,
    };
  });
}

/** Percentile of an unsorted numeric array. */
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}
