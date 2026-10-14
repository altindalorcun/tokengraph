# Story cards: design rules

Date: 2026-10-11 (updated 2026-10-13 for the CLI, where `tokengraph story` renders them on your
machine). This note keeps the design decisions and the
rules the cards follow. Where the code lives now: pure story data in `packages/core/src/story/`,
the Satori + resvg pipeline and the card layouts in `packages/cli/src/story/`.

## Goal

Next to the README graph, give people an image they can post to an Instagram or TikTok story, the
way Strava does for a run: a few fixed designs whose numbers change. Every post carries the brand
and the call to action (`npx tokengraph`), which is free advertising.

## What ships

- **Three designs**, all drawn from the same numbers as the graph and the terminal view:
  - **Skyline** (1080×1920): the big number, the person's recent weeks as an isometric city of
    towers (height = weighted tokens, hue = the day's model family, the shared period lit, the rest
    dark), a light beam on today (or the period's best day), the models and three stats.
  - **Receipt** (1080×1920): a thermal-printer receipt. Models as line items (QTY = share), the
    raw token types with cache reads "discounted" to a tenth (the weighting formula, spelled out),
    the weighted TOTAL, est. cost, streak, a Code 128 barcode of the call to action. It lies on a
    huge tilted contribution graph of the person's own weeks.
  - **Sticker** (1080×1380, transparent): Strava's trick. Numbers and a frosted-glass city only,
    to lay over your own photo.
- **Periods:** Today, 7 days, 30 days, 12 months. The 12 month skyline starts at the first week
  with usage (12–53 weeks), so a young account is not a long empty runway.
- **Badge:** "Personal best" (heaviest day of the loaded year), "Top N% day" (top decile, with at
  least a week of history) or an "N-day streak" (≥ 7). None otherwise.
- **Cost** is optional; unpriced is never $0, it falls back to the cache hit rate.

## Rules the cards follow

- Same numbers as the graph: days weighted first, then summed; levels are the person's own
  percentiles; colours are model families, never agents; unpriced is unknown.
- Instagram and TikTok cover roughly the top and bottom 14% of a story: readable content sits
  between y = 250 and y = 1670 (`packages/cli/src/story/cards/context.ts`).
- Satori constraints: flexbox only, inline styles, every multi-child element `display:flex`; no
  `inset`; nested SVG goes in as a data-URI `<img>` and gets no fonts, so the skyline, barcode and
  logos are shapes only and all text is laid out by Satori.
- **Render cost:** resvg rasterising is almost all the time. CSS gradient backgrounds become SVG
  `<pattern>`s, which resvg draws slowly, so backgrounds are one flat SVG of gradient fills
  (`backdropSvg`); blurred shadows (`box-shadow`, filters over large areas) cost seconds, so the
  receipt's shadow is a gradient. Measured in Node with resvg-wasm: skyline ~0.74 s, receipt
  ~0.68 s (5 s with the blurred shadow), sticker ~0.88 s at full size.
- Fonts: TrueType subsets of IBM Plex Sans/Mono (Satori cannot read woff2), shipped with the
  package in `packages/cli/assets/` together with `resvg.wasm`.

## Not done

- The barcode is a correct Code 128 B encoding (checksum tested) but was not scanned with a reader.
- TikTok's right-hand buttons overlap the right edge of a story; the cards keep only the beam label
  there.
