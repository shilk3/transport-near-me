# Transport Near Me

A phone web app that maps Sydney public transport around you, using live data from Transport for NSW:

- every bus stop, train, metro, light rail and ferry stop within a radius (default 1 km)
- every service that will reach one of those stops within a time window (default 60 min), with its live position if it's on the road
- each service's route from inside the circle to the end of the line, plus a dashed lead-in from where the vehicle is now

Tap a service (in the list or on the map) to highlight its route and see its times at the nearby stops. Tap a stop for its next arrivals. Long-press the map to look around somewhere else; the target button brings you back. Tap ☆ on a service to make it a favourite; the ★ Favourites chip shows only favourites. Radius, time window, starting zoom (default 200%, where 100% fits the whole circle) and whether to open with the favourites filter on are in settings (the slider button).

On iPhone, open the site in Safari and use Share → Add to Home Screen so it runs full-screen like an app.

## How it works

- `scripts/build-network.mjs` runs at deploy time. It streams the TfNSW static GTFS bundles and keeps only stop locations, route names and, for trains, ferries and regional trains (whose realtime feeds mostly send delays), four weeks of scheduled stop times (`data/network.json`). The build records when that timetable runs out (`data/meta.json`). A daily Vercel Cron calls `api/refresh.js`, which triggers the project's deploy hook (`DEPLOY_HOOK_URL`) a week before expiry or once the data is three weeks old, so the app keeps itself current.
- `api/nearby.js` fetches the GTFS-Realtime feeds for every mode (vehicle positions cached for 10 s, the much larger trip updates for 30 s), finds trips calling at stops in the circle within the window, and returns them with their remaining stops as the route line.
- `public/` is a static Leaflet frontend that refreshes every 10 s, with a countdown circle you can tap to refresh now.
- `api/status.js` shows feed health and counts, which is handy for checking the API key works.

Route lines follow the road or track using the GTFS shapes, cut into sections between neighbouring stops at build time (straight lines only where a section has no shape).

## Setup

Needs a free TfNSW Open Data API key (opendata.transport.nsw.gov.au) with access to the Public Transport realtime and timetable datasets.

Deploy to Vercel and set `TFNSW_API_KEY` in the project's environment variables. The build downloads the stop data, so the key is needed at build time too. For self-refresh, also set `CRON_SECRET` (any random string) and `DEPLOY_HOOK_URL` (Project Settings → Git → Deploy Hooks, for the production branch).

## Local development

```sh
npm install
npm run mock                       # generated data, no key needed → http://localhost:3000
TFNSW_API_KEY=... npm run build-network
TFNSW_API_KEY=... npm run dev      # real data
npm test
```

Add `?at=-33.87,151.207` to the URL to start at a fixed point instead of your GPS location.
