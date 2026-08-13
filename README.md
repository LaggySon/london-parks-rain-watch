# London Parks Rain Watch

A live rainfall dashboard and Three.js visualisation for Hyde Park, St James's Park,
Regent's Park, Kensington Gardens and Greenwich Park, answering one question for an
arrival on **28 August 2026**: will the grass be green, and will it be any good to sit on?

The honest answer for the current London drought is no, and most of this project exists to
say so with numbers rather than to guess. An earlier version made green cover a linear
function of forecast millimetres and reported 57% cover and a 64% chance of green for a
summer in which the parks had received 3.4 mm of rain in three months. Rainfall alone cannot
answer the question; what the ground has already been through dominates.

## Deploy

1. Import this repository into Vercel.
2. Keep the detected framework as **Next.js**.
3. Deploy. No environment variables are required.

Locally: `npm install`, then `npm run dev`, then open
<http://localhost:3000/london-parks-rain-watch.html>. The visualisation is a single static
HTML file with no build step, so a browser reload — not HMR — is what picks up edits to it.

## The model

`lib/greenness.mjs` is a pure, dependency-free daily water balance and turf model. No I/O,
so it can be run against synthetic weather; `scripts/check-greenness.mjs` does exactly that.

**Soil water.** A two-reservoir root zone after MORECS, the Met Office's operational UK
grassland balance, split 40/60 between a crown layer and the rest of the root zone. Total
available water comes from FAO-56 Table 19 (field capacity and wilting point by soil class)
and Table 22 (rooting depth). Evaporative demand is `Kc · Ks · ET₀`. `Kc` is **0.85**: Table 12
gives 0.95 for cool-season turf and notes it may be reduced by 0.10 where water is managed
carefully and rapid growth is not wanted, which describes public parkland. `Ks` is the
FAO-56 water stress coefficient with a depletion fraction `p = 0.40 + 0.04 · (5 − ET₀)`
clamped to 0.1–0.8.

**Canopy interception.** Turf intercepts the first **4.4 mm** of any fall before a drop
reaches the soil, and passes on 0.84 of each additional millimetre (Kruse et al., *PLOS ONE*
17(9) e0271236, 2022). This single fact drives most of the counter-intuitive results in the
app: drizzle is agronomically worthless. Fifteen days of 1.7 mm/day is not a wet fortnight,
it is a drought with wet leaves. Water held on the canopy evaporates instead of being
transpired, so it is subtracted from demand rather than charged twice.

**Greenness.** Integrated daily with deliberately asymmetric time constants — browning runs
on about 7 days, greening on about 10 — because grass loses colour far faster than it regains
it. Growth is scaled by temperature after Beard (1973), with a cool-season optimum of
15.5–24 °C, so a 36 °C day contributes nothing.

**Mortality ceiling.** Past a 30-day dormancy grace period, achievable recovery falls by
0.0136/day toward a floor of 0.50: after a long enough drought much of the sward is dead
rather than dormant, and no amount of rain regrows it inside a fortnight. UMass Extension
puts recovery at roughly 70% after 45–60 dormant days. **The 0.50 floor is a reasoned
assumption, not a measurement**, and it is the single constant with the most influence over
the app's headline answer.

**Good to sit on** is scored separately from colour, because hard-baked dusty ground and
lush waterlogged ground both score badly while looking nothing alike. It combines green
cover with a "baked" term from root-zone dryness and a "muddy" term from a long wet spell at
high soil moisture.

### Per-park parameters

These are **documented assumptions about the Royal Parks, not fetched data**.

| Park | Soil | Root depth | Available water | Normally watered | Exposure |
| --- | --- | --- | --- | --- | --- |
| Hyde Park | loam | 0.40 m | 58.9 mm | 12% | 1.00 |
| St James's Park | loam | 0.42 m | 63.8 mm | 45% | 0.95 |
| Regent's Park | clay loam | 0.40 m | 60.1 mm | 22% | 1.00 |
| Kensington Gardens | loam | 0.38 m | 56.0 mm | 30% | 0.95 |
| Greenwich Park | sandy loam | 0.30 m | 29.3 mm | 5% | 1.12 |

Greenwich is the outlier in both directions: thin stony soil over Blackheath sand and gravel
on an exposed hill browns fastest, but its small reservoir also refills fastest, so it can
respond *better* than Hyde to a single middling soaking.

Watering is applied only to a park's irrigated fraction. A **Thames Water Temporary Use Ban**
has been in force since 23 July 2026 and amenity turf is not among the exemptions, so during
the ban only 15% of normal irrigation is modelled — watering cans and the parks' own
abstraction. The 92-day spin-up therefore runs in two legs, unrestricted up to the ban date
and restricted after it, rather than pretending the whole summer was one regime. The ban is a
hand-maintained constant in `app/api/greenness/route.ts`: it is published as press releases
and JavaScript-rendered help pages, not as an API.

## Forecast sources

Only numerical weather prediction models, served through Open-Meteo's model endpoint with
documented units and provenance.

| Model | Nominal weight | Endpoint |
| --- | --- | --- |
| ECMWF IFS | 40% | `ecmwf_ifs025` |
| Met Office (UKMO) | 25% | `ukmo_seamless` |
| DWD ICON | 20% | `icon_seamless` |
| NOAA GFS | 15% | `gfs_seamless` |

Earlier versions also scraped three consumer forecast sites. They were removed rather than
fixed, because none could be trusted for a water balance: Timeanddate served a Cloudflare
interstitial to every non-browser client; The Weather Network publishes rainfall only as
qualitative bands (`<1 mm`, `1-3 mm`, `~5 mm`) that a regex had to midpoint into a number;
and Weather25 publishes no probability at all, so its "chance of rain" was invented by a
curve in this repository. A rebadged, regex-parsed number is not a second opinion.

**Blending is done per day, not per window.** The models reach different distances ahead:
UKMO and ICON run out around day 7 while ECMWF and GFS cover the fortnight. Weights are
renormalised over whichever models actually cover each day, so the table reports both a
nominal weight (what a model carries on a day it covers) and an effective weight (what it
carries across the whole window). An earlier version reduced each model to a daily rate and
projected it across the window, which quietly turned UKMO's 7-day forecast into a 15-day
number the Met Office never issued.

**Probability is never fabricated.** UKMO publishes no probability of precipitation through
this endpoint, so it reports `null` and is excluded from the probability average, which is
renormalised over the models that do publish one. The app used to display a "Met Office 55%"
that the Met Office had never said.

Rainfall uncertainty comes from **52 ensemble members** — `gfs05` (31) and `gem_global` (21),
both covering the full window. `icon_eu` reaches only about a third of it, and `ecmwf_ifs04`
and `bom_access_global_ensemble` return nothing for this point, so all three are excluded.
Per-model ET₀ is too patchy to use (UKMO returned 2 of 16 days), so **demand is shared across
members and only precipitation varies**. That understates the true spread a little, since a
wetter member would also be a duller, cooler one.

## What the API returns

`/api/greenness` reports, per park: green cover at arrival with the ensemble p10/median/p90,
the probability of clearing "noticeably green" (0.45 cover) and the lower "visibly greening"
milestone (0.25), the sit-on-it score and verdict, drought context, a daily series for the
sparkline, and a modelled-versus-measured soil moisture anchor. If the two disagree sharply
the bucket parameters are wrong, so both are returned rather than reconciled.

It also answers **what it would take**, which for a drought this deep is the more useful
output. Deltas are given for looking green, for visibly greening, and for the two sit-on-it
bars (0.60 "yes", 0.40 "just about"), all as uniformly spread rain — and then the same
sit-on-it question is asked of five concrete rainfall patterns: a little every day, three
soakings five days apart, two soakings a week apart, one soaking a week before arrival, and
one downpour the day before.

Listing patterns separately is the point. The same total is either useful weather or wasted
weather depending on how it arrives, and the totals differ by a factor of several between
patterns. Each case reports the smallest total that clears the bar and — because wetter is
not monotonically better — the best that pattern can ever do and the total at which it peaks.
Several patterns top out just short, and a pattern that tops out at 59.7% is a different
answer from one that never gets near. Rain on the eve of arrival peaks lowest of all: grass
cannot use water it has not had time to grow into.

Two properties fall out of the model rather than being asserted, and both are worth knowing:
a park can be comfortable to sit on while still looking patchy, because thin green cover over
damp soil is pleasant to sit on and unimpressive to look at; and over a long window, uniform
daily rain can need *more* millimetres to be sittable than to look green, because holding
soil near capacity for weeks greens grass and softens ground at the same time.

## Verification

```bash
node scripts/check-greenness.mjs
```

Runs 55 dependency-free assertions against synthetic weather. Each names the published
figure it encodes, so a failure means either a coding mistake or a genuine disagreement with
the agronomy literature — both worth knowing about. Covered: the FAO-56 soil profile and
depletion fraction, the 4.4 mm canopy threshold and its 0.84 slope, drizzle versus one decent
fall, the Beard growth-temperature response, the UMass recovery ceiling, browning under a
three-month drought, the lag that makes eve-of-arrival rain worthless, published watering
rates behaving as published (1 inch/week prevents dormancy, ¼ inch/week does not restore
colour), capped green-up after a long drought, runoff on baked ground, the ordering between
parks, the effect of a hosepipe ban, and the sit-on-it deltas and delivery patterns.

## Caveats

Estimates from a soil-water-balance and turf model, not official forecasts. The turf time
constants and the mortality floor are physically reasoned but **not calibrated against London
park observations**. Per-park soil, root depth and irrigation coverage are reasoned
assumptions. Figures are park averages: a widely irrigated park has greener showpiece lawns
than its average implies, and the trees stay green throughout regardless of what the grass
does.

## Sources

- FAO-56 (Allen et al.), Tables 12/19/22 — crop coefficient, soil water characteristics,
  rooting depth and depletion fraction
- MORECS — the Met Office's operational UK grassland balance, which splits available water 40/60
- Kruse et al., *PLOS ONE* 17(9) e0271236 (2022) — turf canopy intercepts 4.4 mm before any
  throughfall
- UMass Extension — 45–60+ dormant days leaves only ~70% recovery; green-up takes two weeks
  or more
- Iowa State Extension — 25 mm/week prevents dormancy; 6 mm/week keeps crowns alive without
  restoring colour
- Beard (1973) — cool-season shoot growth optimum 15.5–24 °C
