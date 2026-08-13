# London Parks Rain Watch

A Vercel-ready live rainfall dashboard and detailed Three.js visualization for Hyde Park, St James's Park, Regent's Park, Kensington Gardens, and Greenwich Park.

## Deploy

1. Import this repository into Vercel.
2. Keep the detected framework as **Next.js**.
3. Deploy. No environment variables are required.

## Forecast sources

`/api/forecast` builds a weighted ensemble for the days between today and the trip
start, and reports per-source coverage so a short-range model is visibly distinct
from one that spans the whole window.

| Source | Weight | How it is fetched |
| --- | --- | --- |
| Met Office (UKMO) | 35% | `ukmo_seamless` daily fields from the Open-Meteo model API |
| Timeanddate | 20% | **Not live** - the site answers non-browser clients with a Cloudflare challenge, so this slot stays on its verified baseline |
| Weather Network | 15% | 14-day page scrape; daily rain bands (`<1 mm`, `1-3 mm`, `~5 mm`) and P.O.P. |
| Weather25 | 10% | 14-day page scrape; per-day millimetre totals |
| ECMWF IFS | 20% | `ecmwf_ifs025` daily fields from the Open-Meteo model API |

Sources reach different distances into the window, so the ensemble reduces each to
a daily rate before weighting rather than comparing raw totals. Results are cached
for 30 minutes and any source that fails falls back to its verified baseline with
the reason attached. Park appearance and green probabilities are estimates, not
official forecasts.
