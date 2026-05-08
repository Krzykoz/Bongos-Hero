# Starter Song Attribution

These tracks ship pre-charted with Bongos Hero so a fresh clone has playable
content out of the box without needing `yt-dlp` / `ffmpeg` / `aubioonset`
installed locally. They are all by Kevin MacLeod (incompetech.com) and are
licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**.

License full text: <https://creativecommons.org/licenses/by/4.0/>

Per the CC BY 4.0 terms, the attribution below is the required notice. If you
fork or redistribute Bongos Hero with these audio files included, keep this
file (and the music itself) intact.

---

## Sergio's Magic Dustbin

- **Artist:** Kevin MacLeod (incompetech.com)
- **License:** CC BY 4.0 — <https://creativecommons.org/licenses/by/4.0/>
- **Source:** <https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100481>
- **ISRC:** USUAN1100481
- **Bongos Hero ID:** `28f7e791-d35c-5d05-99b6-9763ffe2665f`
- **Genre / feel:** Bouncy / driving / humorous (drums, tuba, marimba, percussion, clarinet)

> "Sergio's Magic Dustbin" by Kevin MacLeod (incompetech.com) — Licensed under
> Creative Commons: By Attribution 4.0 License
> <http://creativecommons.org/licenses/by/4.0/>

## Ghostpocalypse - 7 Master

- **Artist:** Kevin MacLeod (incompetech.com)
- **License:** CC BY 4.0 — <https://creativecommons.org/licenses/by/4.0/>
- **Source:** <https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100662>
- **ISRC:** USUAN1100662
- **Bongos Hero ID:** `3f69750d-4339-50fe-900c-64160c2314e0`
- **Genre / feel:** Electronic / cinematic / intense (synths + percussion)

> "Ghostpocalypse - 7 Master" by Kevin MacLeod (incompetech.com) — Licensed under
> Creative Commons: By Attribution 4.0 License
> <http://creativecommons.org/licenses/by/4.0/>

## Surf Shimmy

- **Artist:** Kevin MacLeod (incompetech.com)
- **License:** CC BY 4.0 — <https://creativecommons.org/licenses/by/4.0/>
- **Source:** <https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1700018>
- **ISRC:** USUAN1700018
- **Bongos Hero ID:** `6e5afd28-923b-540f-9621-a3fb92d0d22c`
- **Genre / feel:** Surf-rock / bouncy / grooving (guitar, bass, drums, organ)

> "Surf Shimmy" by Kevin MacLeod (incompetech.com) — Licensed under
> Creative Commons: By Attribution 4.0 License
> <http://creativecommons.org/licenses/by/4.0/>

---

## Re-importing or replacing

The on-disk layout for each track is the same as anything `/api/import`
produces:

```
data/songs/<id>/
├── audio.ogg     # Opus, EBU R128 loudness-normalized to -16 LUFS
├── chart.json    # ChartV1 produced by buildChart() (full Hard chart)
└── meta.json     # SongMeta
```

To regenerate a chart with different tunables for one of these tracks, use
`POST /api/rechart` with the `Bongos Hero ID` as `songId` — it re-derives
onsets + features from the cached `audio.ogg` and overwrites `chart.json`.
