# Bongos Hero — Copilot instructions

A 2-lane keyboard rhythm game (PS2-Guitar-Hero-styled) with auto-charting from any YouTube URL.
Local-only, no accounts. See `README.md` for the full design + gameplay reference; this file
captures what an AI agent needs to be productive in the codebase.

## Workspaces

npm workspaces monorepo, ESM-only, Node ≥ 20:

- `packages/shared` (`@bongos-hero/shared`) — pure-TS types & constants shared by both apps
  (`ChartV1`, `ChartNote`, `SongMeta`, `JobState`, `Judgment`, `JUDGMENT_WINDOW_MS`,
  `JUDGMENT_SCORE`, `DIFFICULTY_CONFIG`). The chart format and the runtime scoring windows live
  in the same file on purpose so they cannot drift apart — change them here, not in app code.
- `apps/server` (`@bongos-hero/server`) — Fastify + `tsx` import/playback API on `:5174`.
  Pipeline: `ytdlp.ts` → `transcode.ts` (ffmpeg loudnorm → Opus/Ogg) → `onsets.ts` (aubioonset)
  → `audioFeatures.ts` (PCM stereo balance + spectral centroid + RMS) → `chart.ts` (8-step lane
  classification → `ChartV1`). Each stage is sequenced inside `JobsManager.runJob` (`jobs.ts`),
  with `concurrency: 1`. Routes are registered in `routes.ts`.
- `apps/web` (`@bongos-hero/web`) — Vite + Canvas-2D client on `:5173`. Vite proxies `/api/*` to
  `:5174` (see `apps/web/vite.config.ts`); the client only ever talks to one same-origin URL.

## Commands (run from repo root)

| Command                      | What it does                                                        |
| ---------------------------- | ------------------------------------------------------------------- |
| `npm install`                | Install all workspaces.                                             |
| `npm run dev`                | Web (`vite`) + server (`tsx watch`) in parallel.                    |
| `npm run dev:web`            | Web only on `:5173`.                                                |
| `npm run dev:server`         | Server only on `:5174` (env: `PORT`, `HOST`).                       |
| `npm run build`              | Serial build: `shared` → `server` → `web`.                          |
| `npm run build:{shared,server,web}` | Per-workspace build.                                         |
| `npm run typecheck`          | Serial `--noEmit` typecheck across all three workspaces.            |
| `npm run typecheck:{shared,server,web}` | Per-workspace typecheck (use this on focused changes).   |
| `npm run lint` / `lint:fix`  | ESLint 9 flat config (`eslint.config.js`).                          |
| `npm run format` / `format:check` | Prettier (`.prettierrc.json`).                                 |

There is **no test runner**. Verification is via:

- `apps/server/src/__tests__/store.smoke.ts` and `apps/server/src/scripts/smoke{Chart,Pipeline}.ts`
  — run manually with `tsx`, e.g. `npx tsx apps/server/src/scripts/smokePipeline.ts <url>`.
- `apps/web/src/{audio,game,input}/__smoke__.ts` and `apps/web/src/render/__*Demo__*.ts` — not
  auto-imported; wire them up by hand from a console / scratch entry point. Runs `npm run typecheck`
  + `npm run lint` are the closest thing to CI.

## External binaries (server only)

`apps/server/src/prereqs.ts` probes `yt-dlp`, `ffmpeg`, and `aubioonset` at startup. **The server
intentionally keeps running if they are missing** — only `/api/import` fails; `/api/health` and
`/api/songs[/...]` keep working. Don't add a hard exit.

## Code conventions

- **NodeNext-style relative imports: always include the `.js` extension on TS source imports**
  (e.g. `import { foo } from './bar.js'`). This applies in all three workspaces. Imports of the
  shared package use the bare specifier `@bongos-hero/shared`.
- **All timing values are in milliseconds** unless the identifier is explicitly suffixed
  otherwise. The shared types file states this contract; honor it in new code.
- **Audio is the master clock**, not `requestAnimationFrame`. `AudioEngine.currentTimeMs()`
  (`apps/web/src/audio/engine.ts`) is derived from `AudioContext.currentTime`. The 3-second
  count-in synthesises the clock from `performance.now()` and hands off when `audio.play(0)`
  fires — preserve this hand-off behavior when touching playback.
- **Keyboard input is layout-independent** — `KeyboardInput` (`apps/web/src/input/keyboard.ts`)
  matches by `event.code` (not `event.key`), filters `event.repeat`, and clears held-key state on
  `blur` / `visibilitychange` so a tab-switch never leaves a lane stuck on. Don't regress these.
- **Renderers pre-rasterise once and `drawImage`-blit per frame.** Note sprites
  (`render/noteSprites.ts`), background layers (`render/background.ts`), bongos, and HUD pieces
  are all baked at module init. The per-frame draw loop must not allocate. Fixed internal
  coordinate space is `1280 × 720`.
- **TS is strict + `noUncheckedIndexedAccess`.** ESLint enforces
  `consistent-type-definitions: interface` (use `interface`, not `type`, for object shapes) and
  allows `_`-prefixed unused vars/args. `verbatimModuleSyntax` is off — don't churn imports to
  add `import type` everywhere; the rule is intentionally disabled.
- **Prettier**: single quotes, semicolons, trailing commas everywhere, 100-col width, 2-space
  indent, LF endings.
- **No bundled binary assets.** All SFX are synthesised in-browser at startup
  (`apps/web/src/audio/sfx.ts`, `sfxBank.ts`); all art is procedurally drawn. Don't add image,
  font, or audio files to the repo.

## Data layout & API contract

- Per-song data lives in `data/songs/<uuid>/{audio.ogg, chart.json, meta.json}`. The directory is
  gitignored except for `.gitkeep`. Paths are computed in `apps/server/src/paths.ts` — no override.
- API surface (defined in `apps/server/src/routes.ts`, typed wrapper in `apps/web/src/api.ts`):
  `GET /api/health`, `GET /api/songs`, `DELETE /api/songs/:id`, `GET /api/songs/:id/chart`,
  `GET /api/songs/:id/audio` (HTTP `Range`-aware), `POST /api/import`, `GET /api/jobs`,
  `GET /api/jobs/:id`. The import scene polls `/api/jobs/:id` for progress.
- If you add or change a server route, update `apps/web/src/api.ts` in the same change.
- If you change `PORT`, also update the proxy `target` in `apps/web/vite.config.ts` — they are
  not linked.

## Scenes & router

`apps/web/src/router.ts` is a single-active-scene router with a 250 ms crossfade. Scene IDs are
`'title' | 'songSelect' | 'import' | 'play' | 'results' | 'calibration'`. Each scene implements
optional `enter` / `exit` / `draw(ctx, nowMs)`. `enter`/`exit` are awaited; `draw` runs every
frame from the router's single `requestAnimationFrame` chain. Don't start your own rAF loop in a
scene.

## When changing the chart pipeline

The 8-step lane classification in `apps/server/src/chart.ts` (`buildChart`) is documented in
`README.md` § "How auto-charting works". Key invariants the rest of the code depends on:

- Output is sorted ascending by `tMs` (final defensive sort).
- Every 12th note carries `sp: true`; consecutive `sp:true` notes form a Star-Power phrase.
- `bpm` is the **median** inter-onset interval, clamped to `[60, 200]`. The background renderer
  uses it for the band/crowd pulse.
- Difficulty thinning happens **client-side** via `DIFFICULTY_CONFIG` from
  `@bongos-hero/shared` — the on-disk chart is always the full Hard chart.
