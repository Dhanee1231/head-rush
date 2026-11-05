# Head Rush (web)

Spinning-arena party runner for phones: jump the orange bars, duck the blue ones, last runner standing wins. Live at https://head-rush.vercel.app, played by families, including kids.

## This repo is the live site
- **Pushing to `main` does not deploy.** The Vercel project has no Git link, so the live site only changes on an explicit production deploy. Vercel serves the repo's files as the website, so anything added here gets published on the next deploy unless it's in `.vercelignore`. Never push or deploy; D decides what goes live.
- The repo is public. Never commit secrets. The Supabase anon key in `index.html` is designed to be public; the service-role key must never appear anywhere.
- A Unity build is planned as a separate project (`HEAD_RUSH_BUILD_BRIEF.md`). Never put Unity files here.

## Layout
- `index.html`: the whole game: rules, modes, UI (about 7,400 lines). Plain JavaScript, no build step.
- `hd3d.js`: the HD renderer. `vendor/`: bundled three.js. `icons/`, `vo/`: images and voice lines. `ASSETS.md`: asset notes.
- `sw.js`: service worker. `privacy.html`: privacy page. `supabase/`: database SQL for reference.
- `HEAD_RUSH_BUILD_BRIEF.md`: game rules and numbers, written from the web code. If it and the code disagree, the code wins.
- `tests/`: browser checks, not deployed.

## Run and test
There is no build. Open `index.html` through any local web server.

Run every suite, and all must pass before you finish. Workers run them through `cos-box`, a sealed box with no network, because a browser can't start directly in the worker sandbox. Run this exact line from the repo root, on its own:

```bash
cos-box sh -c 'for t in tests/*.mjs; do node "$t" check || echo "FAILED: $t"; done'
```

Outside a worker, run the same loop without `cos-box`. The tests need Chrome at `/usr/bin/google-chrome` and `puppeteer-core` under `/tmp/hrtest/node_modules`. If something stops them from running, say so and report the exact error; don't change the paths or work around it.

Two suites guard the game's behaviour on purpose:
- `tests/replay.mjs` replays a seeded game and compares it to `tests/golden-hud.json`.
- `tests/identity.mjs` checks that core functions and constants still match a known commit.

If your change fails one of these, assume your change is wrong. Never edit or regenerate `golden-hud.json`, or loosen a test, to make it pass. If a rule really has to change, stop and ask D.

## What "done" means
All suites pass, the change is committed on your task branch, and your summary says what changed and how you checked it. A browser test doesn't prove it feels right on a phone: say so when your change affects feel, and tell D what to try.

## Rules
- **When you change anything the service worker caches (see `CORE` in `sw.js`), change the `CACHE` value in `sw.js`,** or players keep the old version.
- **Readability never breaks:** low bars are always orange (`#ff8a2a`) and high bars always blue (`#3fa9ff`), in every arena.
- **Fairness:** the reaction-gap rule in the brief (section 2) must hold. Bars never arrive closer than the difficulty's gap.
- **Kids and privacy:** nickname only. No email, phone, location, photos or contacts. No ads, no tracking, and no new third-party services or network calls. If stored data changes, `privacy.html` must change too.
  The `log_crash` call to the game's existing Supabase is the one approved exception, for crash reports only.
- **Touch targets are at least 48px tall.**
- **Original names, art and audio only.** Nothing from the game that inspired it.

## Ask D first
Stop and explain in your final message if a task needs any of these: changing gameplay rules or numbers, changing the Supabase database or functions, adding a paid asset or service, or publishing anywhere.
