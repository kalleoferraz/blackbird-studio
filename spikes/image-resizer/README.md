# Image resizer spike

Answers Bible section 10: can the host resize a 12 MP phone photo to 600 px on the longest side, in a worker
thread, with pure JS or WebAssembly (no sharp, no native binaries), and what does it cost in time and memory?
Covers EXIF orientation, PNG with transparency, animated GIF (skipped), plus truncated/garbage/oversized inputs.

## Result in one paragraph (local run, NOT the host)

**wasm-vips 0.0.19** passes every check (26 of 27 fixtures, the 27th is the static GIF, skipped by design).
12 MP JPEG: about 1.1 s cold (new worker + library load), 0.14-0.2 s warm, about 300-340 MB process RSS.
jsquash is about 4x slower warm (0.7 s) and uses about 550 MB at 12 MP (1.75 GB at 48 MP), fails CMYK and misses
Display P3 conversion. Jimp is slowest (4+ s for 12 MP), shows a dark halo on alpha edges, ignores ICC profiles and
fails at 48 MP. See `results/report.md` for the full tables.

## Layout

```
../../src/spike/image/   the module (it lives in the app source) (types, inspect, orientation, naming, resizers/, worker, pool, process, route)
scripts/           fixtures, benchmark matrix, output checks, dev server, pool/crash/stress tests
```

The module is already in the app (`src/spike/image/`) and its route is registered in `src/server/app.ts` when `SPIKE_TOKEN` is set.
After the spike, delete `src/spike/`, `spikes/image-resizer/`, the route registration and the extra dependencies (`jimp`, `@jsquash/*`; keep `wasm-vips` and `exifr` if the resizer is kept).

## Run locally (from `spikes/image-resizer/`, after `npm install` in the repo root)

```
python3 scripts/make_fixtures.py fixtures      # 27 deterministic fixtures + manifest.json (needs Pillow)
npx tsx scripts/run-all.ts                     # every lib x every fixture, one process each -> results/results.json
python3 scripts/check_outputs.py               # PIL checks -> results/report.md
npx tsx scripts/pool-test.ts
npx tsx scripts/crash-test.ts
python3 scripts/stress.py             # needs fixtures-stress/ (48 MP JPEG, 35 MP PNGs)
```

## Use in the app

```ts
import { imageSpikeRoutes } from './spike/image/route.js';

await app.register(imageSpikeRoutes, {
  authorize(request) {            // REQUIRED. Throw an error with statusCode 401/403 to refuse.
    if (request.headers['x-spike-token'] !== process.env.SPIKE_TOKEN) {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }
  },
});
```

Routes (remove the whole folder when the spike is over):

```
GET  /spike/image/info
POST /spike/image/resize?lib=wasm-vips&name=photo.jpg&quality=82&return=json|file
     body: the raw image bytes (max 25 MiB)
```

```
curl -s -H "x-spike-token: $T" --data-binary @photo.jpg \
  "https://<preview-host>/spike/image/resize?lib=wasm-vips&name=photo.jpg"
```

The JSON answer carries `status` (resized / skipped / failed), the output name `{base}_{W}x{H}.{ext}`, and
metrics: inspect, round trip, worker spawn, library init, per-step ms, CPU ms, RSS before/after/peak.
With `return=file` the resized bytes come back and the metrics go in the `x-spike-result` header.

## Running it on the host (what is still open)

1. Deploy to Preview with the guarded route, post a real 12 MP phone photo, once cold and a few times warm.
2. Record time and RSS from the JSON. Compare against the local table.
3. Check that a worker starts (under `tsx watch` the worker boots via `worker-boot.mjs`; in the compiled build it
   is `worker.js`), and that wasm-vips runs with `VIPS_CONCURRENCY=1` (default) and with 2.
4. Post a 48 MP image only if the host's memory limit is known; peak RSS there was about 410-500 MB.

## Behaviour worth knowing

- Copy only if the longest side is above 600; exactly 600 px; name uses the real result size; same format as the
  original; EXIF orientation applied; all metadata stripped; Display P3 and other ICC profiles converted to sRGB.
- `processImage` never throws; failures return a code (`truncated`, `not_an_image`, `too_many_pixels`,
  `unsupported_by_library`, `decode_failed`, `worker_crashed`, `timeout`).
- Pixel cap `maxPixels` defaults to 50 MP. At that size wasm-vips peaks at roughly 0.4-0.8 GB; lower it if the
  host limit is tighter.
- Pool: one worker, one job at a time, timeout, idle shutdown (releases only part of the RSS), crash recovery.
- Not covered: HEIC input, static GIF resizing, WebP output for Jimp.
