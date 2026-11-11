# Head Rush — Unity Build Brief

**For:** Claude Code running on the Beelink SER9 (Linux, Unity Hub installed at `~/Unity/Hub`)
**Owner:** Dhawal Patel ("D")
**Written:** 2026-11-01, from the live web game (repo `Dhanee1231/head-rush`, commit `6288933`, game version 11) and the Head Rush Feature Build Plan (Oct 30)

The web version at https://head-rush.vercel.app is the **reference implementation**. Every rule and number in this brief was read from its code. When this brief and the web code disagree, the web code wins, and you should fix this brief.

---

## 0. Start here

### Kickoff message (D pastes this into Claude Code on the SER9)

> Read `HEAD_RUSH_BUILD_BRIEF.md` in https://github.com/Dhanee1231/head-rush. We're building the Unity version of Head Rush for Android. Clone that repo to `~/projects/head-rush-web` as the read-only reference. Then do section 0's setup checklist, tell me what you found (Unity version, Android modules), and start Milestone 1. Stop at the end of each milestone, show me how to test it on my phone, and wait for my OK before the next one.

### Setup checklist for Claude Code

1. **Clone the reference.** `git clone https://github.com/Dhanee1231/head-rush ~/projects/head-rush-web`. Never edit it from this project; it deploys straight to the live site.
2. **Check Unity.** Look in `~/Unity/Hub/Editor/` for installed editors. Use the newest installed **Unity 6 LTS** editor if present. Confirm it has the **Android Build Support** module (with OpenJDK and Android SDK & NDK). If the module or editor is missing, tell D exactly what to install in Unity Hub; don't try to script the Hub install.
3. **Create the project in its own repo.** New Unity project (URP, 3D) at `~/projects/head-rush-unity`, as a new GitHub repo `Dhanee1231/head-rush-unity`. **Do not** put the Unity project inside the web repo: Vercel serves that repo's files as the website, so a Unity folder there would be published.
4. **Add a `CLAUDE.md`** to the new repo that points to this brief and records the decisions made as you go.
5. **Use `.gitignore` for Unity** (Library/, Temp/, Obj/, Build/, Logs/, UserSettings/) and Git LFS for large binaries (audio, models, textures).
6. **Phone testing.** D tests on a recent Android flagship. Each milestone ends with an installable debug APK (or Build & Run over USB) plus a short "how to test" list.

### Working rules

- One milestone at a time, in order. Each ends with its acceptance checks passing and D's OK.
- Gameplay logic is plain C# with no `MonoBehaviour` dependencies where possible (a `RoundSim` class you can step with a fixed `dt`), so it can be unit-tested with Unity Test Framework and replayed for the knockout replay.
- Match the web game's numbers first, then tune. Put every tunable in one `ScriptableObject` (`GameTuning`) so tuning never needs code changes.
- Ask D before: adding paid assets or services, changing the Supabase database, publishing anything to Google Play, or changing gameplay rules.
- Original names, art and audio only. The game is inspired by Fuzion Frenzy's "Twisted System"; nothing from that game is used.

---

## 1. The game in one paragraph

Head Rush is a portrait-mode phone party game. Up to 8 runners circle a round, spinning arena while bars sweep around it the other way. **Orange bars sweep low: jump. Blue bars swing high: duck.** Each runner has 3 hearts; a hit costs one and stuns you for about a second. Bars speed up every 10 seconds and more join. Last runner standing wins, or when the 90-second timer ends, the most hearts wins. It's meant to be learned in 5 seconds and played "one more round" with family on their own phones.

**Design pillars:** learn in 5 seconds · funny failure · always one more round · premium but readable (obstacles always clear at speed) · fair (players buy style, never advantage).

**Readability rules (never break):** low bars are always orange (`#ff8a2a`), high bars always blue (`#3fa9ff`), in every arena. Backgrounds are darker and less saturated than obstacles and runners. Your runner is always clearly marked.

---

## 2. Core simulation (match these numbers)

Reference: `index.html` → `newRound()`, `update()`, `act()`, `resolve()`, `hit()` (around lines 2514–3285).

### World model

- The arena is a circle of radius 1 (world units). Runners sit on a lane at radius **0.78** (one-lane arenas).
- Positions are **angles** in radians. Runners move forward at **RUN = 0.62 rad/s**. Bars rotate the opposite way at **omega**, starting at **BAR0 = 0.9 rad/s** × arena speed × difficulty speed (× Solo level speed). So the closing speed is `omega + runner speed`.
- The camera is fixed behind your runner; the world turns so your runner stays at the front (bottom-centre of the screen).
- A round starts with a **3-second countdown** (sim time starts at −3). Countdown ticks each second, then "Run!".
- Round length: **90 s** in Party and Rooms; Solo levels have their own length; Survival is endless.

### Moves

| Move | Effect |
|---|---|
| Jump (swipe up, Jump button, ↑/W/Space) | Airborne for **0.5 s** (**0.8 s** on Orbit Station). Jumping cancels a duck instantly. |
| Duck (swipe down, Duck button, ↓/S) | Ducked for **0.5 s**. Ducking in mid-air drops you down instantly ("fast drop"). |
| Lane switch (Frost Peak only: tap arena, swipe sideways, Lane button, ←/→/A/D) | Moves to the other lane over **0.16 s**. |

- **Input buffer:** a press made while stunned, or a jump made while already in the air, is queued and fires as soon as it's allowed, if within **0.25 s**.
- **Swipe thresholds (web):** vertical swipe when |dy| > 14 px and |dy| ≥ 0.9·|dx|; sideways swipe when |dx| > 28 px; a tap under 14 px and 260 ms switches lane on Frost Peak. Scale these to dp in Unity.
- Bars only count for collisions **0.5 s after they appear**.

### Hits, dodges and close shaves

- When a bar crosses a runner: if the runner is in the right state (airborne for orange, ducked for blue), it's a **dodge**; otherwise a **hit**.
- **Close shave:** a dodge where the move was made less than **0.12 s** before the bar arrived (0.20 s for ice-wall lane switches). It pays **5 × combo multiplier** coins, plays a sound, and sometimes an announcer line.
- **Hit:** lose 1 heart, **stunned 1.1 s** (you keep moving at 45% speed), any jump/duck is cancelled. A shield absorbs one hit instead (0.45 s stun, no heart lost).
- **Out:** at 0 hearts. In Party, your place is (runners still alive + 1).
- **Time up:** place = 1 + number of surviving runners with more hearts than you. Place 1 = win.

### Combo meter

- Each clean dodge adds 1 to the run; a close shave adds 2. A hit resets it to 0.
- Multiplier: **x2 at 6, x3 at 12, x4 at 20, x5 at 30**. Shown beside your runner; colours x2 `#5ee0a0`, x3 `#3fa9ff`, x4 `#c58cff`, x5 `#ff8a2a` with a pulse. The announcer says "On fire!" at x5.
- Your best run is saved and synced (`best_combo`).

### Speed-ups and extra bars (every 10 s = one "level")

| Mode | Per level |
|---|---|
| Party / Rooms | omega × (1 + 0.09 × ramp). At the difficulty's bar levels, add a bar (alternating blue then orange); otherwise toast "Faster!" |
| Solo | omega × (1 + 0.06 × ramp) |
| Survival | omega × (1 + 0.08 × ramp) before 60 s, then (1 + 0.03 × ramp), capped at cap × speed. Extra bars at the difficulty's Survival times, up to 6 bars. |

**Survival milestones:** every 30 s, bonus coins = 10 × (seconds ÷ 30), a burst, an announcer line (30 s to 180 s), and **3.5 s of calm** (bars at 60% speed).

### The reaction-gap rule (most important fairness rule)

Bars must never arrive closer together than the difficulty's reaction gap `gapT`:

1. A new bar is only added into the **widest gap** between existing bars, and only if the resulting smallest gap ÷ closing speed ≥ `gapT`. Otherwise it's skipped.
2. Every frame, omega is capped so `smallestGap ÷ (omega + RUN × beltMax)` ≥ `gapT` (beltMax = 1.65 on Gear Works, else 1), with a floor of 0.5 rad/s.

This is what fixed the old "always late" problem. Port it exactly, and write a unit test that steps 10 minutes of Survival on Hard and asserts the gap never drops below `gapT`.

### Difficulty

| | Easy | Medium | Hard |
|---|---|---|---|
| Base speed × | 0.8 | 1.05 | 1.2 |
| Ramp | 0.55 | 1.2 | 1.5 |
| Party bar levels (add a bar at level…) | 2, 5 | 1, 3, 7 | 1, 2, 6 |
| Survival extra bars at (s) | 20, 50, 90, 130 | 10, 30, 70, 100 | 10, 20, 70, 100 |
| Split bars from level (`splitLv`) | (none on Easy) | 5 | 5 |
| Survival speed cap × | 2.1 | 2.6 | 3.0 |
| Reaction gap `gapT` (s) | 0.70 | 0.44 | 0.38 |
| Bot miss adjust | +0.05 | 0 | −0.015 |
| Coins & XP × | 0.75 | 1 | 1.5 |

### Special bars (not in Solo)

- **Split bar** (not Easy; not Orbit or Carnival): one orange half and one blue half arriving **0.4 s** apart: jump, then duck. From the difficulty's `splitLv` (Medium and Hard 5); at most min(2, 1 + ⌊(level − splitLv) ÷ 4⌋) per round. (Retuned on 2026-11-10 with D's OK: the second bar now comes 10 s sooner and split bars a level later, so the first 30 s is busier and the 40 s spike is gone.) Counts as one bar for the gap rule.
- **Switch bar** (Hard only, Carnival and Orbit): an existing bar becomes one; it flips orange↔blue about **0.8 s** before reaching you, with a flash and haptic. From level 5; at most min(2, 1 + ⌊(level − 5) ÷ 4⌋).

### Power-ups (Party, Survival, Daily; not Solo or Rooms)

- One glowing orb at a time, placed 1.6–2.4 rad ahead of you (random lane on Frost Peak, never inside a wall). First appears 8–13 s in; after a pickup the next comes 8–15 s later; an uncollected orb vanishes after 12 s and the next comes 6–12 s later.
- **Shield** (40%): blocks the next hit, lasts 15 s. **Slow-mo** (35%): bars at 45% speed for 3.5 s, for everyone. **Heart** (25%): +1 heart up to 3; at full health, +10 coins instead.
- Bots can grab orbs too ("Juno grabbed a shield").

### Bots

- 7 bots in Party: **Pip, Juno, Mako, Rex, Tali, Bo, Zuzu**, each with its own colour and a recorded knockout line.
- Each bot looks 2 s ahead, reacts when time-to-impact ≤ its reaction time (0.14–0.30 s, random per bot), and decides once per obstacle.
- Miss chance = max(0.01, 0.032 + 0.02 × level + skill(0–0.04) + 0.04 if the bar is blinked out + difficulty adjust). Half of misses do the wrong move instead of nothing.
- Lane switches for ice walls succeed with chance 0.95 − 0.015 × level − skill.

---

## 3. Arenas

Six arenas, each adding one twist. Reference: `ARENAS` in `index.html` (line ~785), visuals in `hd3d.js`.

| Arena | Setting | Twist (exact behaviour) | Music |
|---|---|---|---|
| **Neon Rooftop** | City skyline at night | Basics only | 112 bpm synth arps |
| **Gear Works** | Clockwork factory | 4 conveyor belts (0.6 rad wide): green ×1.65 runner speed, red ×0.5. Belt tone when you step on one. | 100 bpm metal percussion |
| **Frost Peak** | Icy summit, snow | Two lanes (radius 0.715 and 0.855). 5 ice walls each block one lane at fixed angles; switch lanes to pass. | 96 bpm icy bells, pad |
| **Lava Temple** | Volcano ruins, embers | 6 tiles (0.2 rad wide) cycle: idle 2–6 s → **cracked 1.3 s** (warning sound when near) → **open 2.2 s** (jump it). | 104 bpm drums, drone |
| **Orbit Station** | Space ring, stars | Low gravity: jumps last 0.8 s. **Reverse**: every 11–16 s the bars flip direction, with a 1.5 s "Reverse incoming!" warning. | 90 bpm space pads |
| **Midnight Carnival** | Haunted fairground, bulbs | Arena speed ×0.88. 2 hammers that alternate low/high every 3 s (6 s cycle; match the colour). Bars **blink**: visible 3.6 s of every 4.5 s. | 120 bpm organ oom-pah |

Arena colour themes (floor, track, rim, glow) are in `THEMES` (line ~1153) and `:root` CSS variables. Keep each arena's palette.

---

## 4. Modes

### Party (default)
You + 7 bots, 90 s, chosen arena and difficulty. Rewards: coins = close-shave points + (9 − place) × 10 + 50 if win + bonuses; XP = seconds survived + (9 − place) × 5 + 30 if win + 3 × close shaves.

### Solo (18 levels)
3 levels per arena in arena order. Level a: 30 s, orange only, speed ×1.0, a blue bar joins at 15 s. Level b: 40 s, orange + blue, ×1.05, an orange joins at 20 s. Level c: 45 s, orange + blue, ×1.12, orange at 15 s and blue at 30 s.
Clear = survive to the end. **Stars = max(1, 3 − hits)**. A level unlocks when the previous has ≥ 1 star. Coins = 10 + 10 × stars + close points; XP = seconds + 10 × stars + 3 × close. 54 stars total.

### Survival
Endless; best time per arena and difficulty (Medium is the "real" record shown online). Coins = seconds ÷ 3 + close points + milestone bonuses; XP = 1.5 × seconds + 3 × close.

### Daily Challenge (same for everyone)
- Picked from the **Eastern-time date**: FNV-1a hash of `YYYY-MM-DD` → mulberry32 seeded with `hash ^ 0xda1e` → arena, then twist, then difficulty from `[medium, medium, hard, medium, hard, easy]`. "One heart" never runs on Hard (becomes Medium). Port `dailyFor()` exactly so web and Unity players get the same challenge.
- Twists: **No power-ups** · **One heart** · **Turbo start** (bars 20% faster) · **Crowded** (a second bar joins at 5 s) · **Power-up rain** (orbs twice as often).
- **3 counted tries per day**; your best counts on the daily board. More tries play for fun. A counted try pays +15 coins.
- Coins = seconds ÷ 2 + close points + bonuses (+15); XP = 1.5 × seconds + 3 × close.
- Resets at midnight Eastern. Yesterday's winner gets a crown on the menu.

### Tour (added on the web after this brief was first written)
All six arenas back to back in arena order, **20 s each**, on **one set of 3 hearts**; hearts and combo carry over. Each stage is a one-runner Party round (no bots, power-ups on) whose starting bar speed is × (1 + 0.08 × stage index), with a blue bar joining at 4 s and, from the fourth arena on, an orange bar at 11 s (both still obey the reaction-gap rule). Clear all six for "Tour complete"; no hits at all is a "Flawless Tour" and counts as a perfect round. Coins = 15 × arenas cleared + 40 for finishing + close points + bonuses; XP = seconds + 10 × arenas + 3 × close. Best result per difficulty is kept on the phone only; a Tour is not sent to the round log. Reference: `startTour()`, `tourArm()`, `showTourEnd()`.

### Twists (Party and Survival, optional)
Picked on the menu; Classic is the default and plays exactly as before. **One Heart** (everyone starts on 1 heart) · **Turbo** (bars 20% faster) · **Crowded** (a second bar joins at 5 s) · **Blink** (bars blink like Midnight Carnival's in any arena) · **Moon Jump** (0.8 s jumps in any arena). They are applied to the round after it is set up, like the Daily Challenge twists. Reference: `TWISTS`, `applyTwist()`.

### Survival medals and the record chase (web, 2026-11-10)
- **Medals** per arena and difficulty, from your best Survival time: **Bronze 20 s (+20 coins), Silver 45 s (+40), Gold 75 s (+80), Diamond 105 s (+150)**, paid once when first earned (× the difficulty's reward). Shown as four dots on each arena card in Survival, a row of medals on the menu ("12 of 24 medals on Medium") and on the results card with "Only 6 s to Gold". Nothing new is stored: medals are worked out from the best times. Reference: `MEDALS`, `medalCount()`.
- **Record chase:** during Survival and the Daily, the top-right HUD shows the next target (your record, today's best, or the next medal). In the last 10 s it counts down ("Record in 4 s") and pulses; passing it pops "NEW RECORD!" or the medal name, a chime, sparks, and a spark fountain in HD. Reference: `chaseArm()`, `chaseTick()`.
- **Quick retry:** "Run again" from a results card starts with a 1.6 s countdown instead of 3 s and skips the arena intro line.

### Beat-my-run links (web, 2026-11-10)
Every Survival round (not the Daily) starts from a random seed, so the same seed replays the same bars. The results card has **"Challenge a friend to beat 0:46"**, which shares `?beat=<seed base36>-<arena>-<difficulty>-<twist>-<tenths of a second>`. Opening it sets up that Survival round on the menu ("Beat 0:46"), and the HUD chases the friend's time instead of your own record. The link holds no name or player data. Changing arena, difficulty, mode or twist drops the challenge. Reference: `beatLink()`, `parseBeat()`, `useChallenge()`.

### Party Rooms (online)
See section 7.

### Guided first round (new players)
After a new player types their name: a slow round on Neon Rooftop, Easy, no timer.
1. An orange bar approaches and **freezes** 0.6 s away with "Swipe up or tap Jump"; the Jump button pulses. Wrong move → a hint toast. Right move → the bar releases and they clear it.
2. Same for a blue bar and Duck.
3. One of each at full speed. A hit restarts that step ("Let's try that again").
Ends with confetti, announcer "You've got it!", **+30 coins the first time**, and "Play my first round" (Party on Easy).
New players play Easy for their first 3 rounds; after the third, one tap suggests Medium. Tips appear on the results card for rounds 1–5. Settings has "Replay tutorial".

---

## 5. Progression (stored on the phone)

- **Several players per phone**, each with a name (1–14 chars) and their own coins, XP, looks and records. "Switch player" on the menu.
- **Levels:** level 1 needs 100 XP, then each level needs 100 + 40 × (level − 1).
- **Daily goals:** 3 per day (local date, seeded from the date) from this pool, each paying coins: no-hit round (80), survive 45 s (50), 3 close shaves in a round (60), 10 close shaves today (80), top 3 twice in Party (60), grab 3 power-ups (50), 3 stars on a Solo level (70), 60 s in Survival (80), win a round (100), play 5 rounds (40), last the full 90 s (90), 30 s without a hit (80), and a round in each of the 5 non-Neon arenas (30 each).
- **Play streak:** finish one round per Eastern day to keep it. Bonus coins = min(70, 10 × streak days). **One free freeze per week**: missing a single day doesn't reset it.
- **Perfect round:** no hits, not knocked out, at least 15 s, in a timed mode. Gold badge on the results card; counted in the profile (`perfect_rounds`). **10 perfect rounds unlock the "Perfect Gold" look.**
- **Locker:** looks bought with coins, some level-gated: Sunny (free), Lime Visor 60, Bubblegum 80, Frostbite 120 (Lv 2), Little Devil 150 (Lv 2), Royal 250 (Lv 3), Ghost 300 (Lv 5), Champion 500 (Lv 8), Perfect Gold (10 perfect rounds). Each is a colour plus an accessory (visor, spots, antenna, horns, crown, halo, star).
- **Body shapes:** round, triangle, square, diamond, star (free, picked in the Locker or the room lobby).
- **Personal bests** per arena: rounds, wins, best place, longest survival.
- **Trails** (Locker tab "Trail"): sparks behind your runner and a pop when you land, drawn as particles only. Sparkles (free), Berry Fizz (400 coins earned in total), Mint Breeze (3 Survival medals), Comet (1,500 coins), Candy Swirl (8 medals), Stardust (4,000 coins), Diamond Dust (16 medals). Coins are never spent; the total earned unlocks them. Trail colours stay away from the bar orange and blue. Only your own trail shows; it is not sent to rooms.
- **Results card:** title (WINNER! / 3rd of 8 / Lasted 1:12…), a one-line reason for the knockout ("A blue bar got you. Blue means duck."), place, time survived, close shaves, coins (counting up), XP bar with level-up burst, completed goals, streak, combo, "4.2 s off your record" / "New record!" nudges.

---

## 6. Art, audio and feel

### Look
Stylized, premium, toy-like 3D (think animated film, not realism): chunky rounded runners with big eyes, glossy materials, rich lighting, bloom on glowing things, bold colour. The web HD renderer (`hd3d.js`, three.js with bloom, shadows, a fixed camera at about (0, 6.4, 11.6) looking at the arena) is the visual reference; match its framing first, then go further.

- UI fonts: **Lilita One** (display) and **Atkinson Hyperlegible** (UI), both free Google Fonts.
- Main colours: background `#191a33`, panel `#22244a`, your runner/accent `#ffd23f`, hearts `#ff4d6d`, low `#ff8a2a`, high `#3fa9ff`.
- Room colours: Sunny `#ffd23f`, Coral `#ff6b6b`, Mint `#5ee0a0`, Violet `#b48cff`, Bubblegum `#ff8fd8`, Snow `#f4f2ff`, Lime `#c6f06a`, Peach `#f6b8a0`.
- Graphics quality: tiers picked automatically on first launch, adjustable in settings, and lowered automatically if frame rate drops. Targets: 60 fps on recent phones, stable 30 fps on 4-year-old phones.

### Juice
Screen shake on hits (off with reduced motion), particles on hits/pickups/close shaves, confetti and a podium for winners, squash-and-stretch on jumps, comic bonk sound, haptic patterns on hit / close shave / combo / milestone / win.

### Announcer
62 recorded lines in `vo/*.mp3` (arena intros, "Go!", knockouts generic and per bot, "you're out", round calls, milestones 30 s–180 s, power-ups, close shaves, "On fire!", "Perfect!", reverse, split/switch bar warnings, tutorial lines, win/lose, champion). Generated with Piper TTS ("en-us-libritts-high", MIT / CC BY 4.0, credit in `vo/CREDITS.txt`). Copy them into the Unity project as-is. Lines have priorities so important calls interrupt minor ones; music ducks under the voice; voice can be turned off.

### Music
The web game generates music live: a small sequencer per arena (bpm, scale, chord progression, drum patterns, bass, lead), tempo rising with bar speed (config `MUSIC`, line ~2294). For Unity, either port that sequencer, or record loops and change playback speed with bar speed. **D still has to judge whether this music is good enough; the fallback is a licensed track pack (about $15–40).** Separate Music and Effects volume sliders.

### End-of-round extras
- **Knockout replay:** the last ~2 s before you were knocked out, replayed in slow motion (0.35×) on the results card. The sim records a snapshot every frame for the last 3.2 s.
- **Share:** a result image card (1080 × 1350) with title, stats and "Beat that!"; and a 5-second clip of the replay. Use the Android share sheet.

---

## 7. Online (Supabase)

Project: **`yxmdlqmmzozghquqlnss`** (named head-rush). The public URL and anon key are in `index.html` (`SB_URL`, `SB_KEY`); the anon key is designed to be public. Never put the service-role key in the app.

### Player identity (no accounts)
Each player profile gets a random **UUID** (`cloudId`) and a random **24-byte hex secret** on first use, stored on the phone. The server stores only the secret's SHA-256. Every write passes `p_id` + `p_secret`. Keep this model.

### Tables (all with row-level security)
- `players`: id, name (1–14), secret_hash, survival_best, survival_arena, party_wins, party_rounds, best_place, solo_stars (≤ 54), level, skin, best_combo, perfect_rounds, timestamps. Public read for the leaderboard.
- `rounds`: one row per finished round (player_id, mode, arena, difficulty, seconds, place, win, hits, close_shaves, stars, game_version, match_id, daily). Private; used to measure play.
- `daily_scores`: (day, player_id) → best seconds, arena, difficulty, tries.
- `feedback`: player_name, rating 1–5, liked, improve (≤ 600 chars each), context.
- `push_subs`: web-push subscriptions for streak reminders.

### Functions the game calls
| Call | What for |
|---|---|
| `rpc/submit_score` (13 args incl. `p_best_combo`, `p_perfect`) | Upsert leaderboard row after every round |
| `rpc/log_round` (14 args incl. `p_match`, `p_daily`) | Round log; queue offline, max 50 queued |
| `rpc/submit_daily` / `rpc/daily_board(p_day, p_id)` | Daily Challenge best and board (top 10, total, your rank, yesterday's winner) |
| `rpc/delete_player(p_id, p_secret)` | "Delete my data" (deletes the player; rounds cascade) |
| `rpc/save_push` | Streak-reminder subscription |
| `GET players?select=…&order=…` | Leaderboard tabs: Today, Survival, Party, Solo, Combo |
| `POST feedback` | Feedback form |

**Status, checked 2026-11-01:** `delete_player` is **not yet in the database**. D still needs to run `supabase/delete_player.sql` in the Supabase SQL editor (or approve someone running it). Until then the Delete button fails safely with a "nothing was deleted" message.

**Before changing the database:** ask D. Prefer adding new functions over changing ones the live web game calls, so the web game keeps working.

### Party Rooms protocol (Supabase Realtime)
Reference: `index.html` lines ~4275–4890.

- **Channel:** `headrush-room-<CODE>`, CODE = 4 letters from A–Z without I and O. Presence key = the player's `cloudId`. Broadcast with `self: false`.
- **Presence payload:** name, skin, joinedAt, arena, bots, d (difficulty), status (lobby/playing), host flag, c (colour index), sh (shape), v (game version).
- **Host** = the room creator (then earliest joined). Only the host picks arena (or "Random": no repeats until all 6 are used), difficulty and bots (0–7, filling up to 8 runners). Each player picks a free colour and a shape.
- **Start:** host broadcasts `start` {seed, arena, diff, host, roster, match}. Every phone runs the round with the same **mulberry32(seed)** so bars and holes match.
- **During the round:** each phone simulates its **own** runner and decides its **own** hits. It broadcasts `g` {id, a: angle, l: lane, h: hearts, o: out, s: 'j'/'d'/'', k: action} every **200 ms** and on every action. The host also simulates the bots and sends them in `g.bots`. Remote runners are smoothed toward their last reported angle. A remote silent for **10 s** is marked lost; it comes back if it reports again.
- **Best of 5:** after the round is decided (one left, or time up), the host waits 450 ms, ranks everyone (still in > out; among the out, later is better; among the in, more hearts), awards **3 / 2 / 1** points to places 1–3, counts round wins, and broadcasts `res` {seed, match}. First to **3 round wins** is champion, or the leader after **5 rounds**. The next round starts automatically after **6.5 s**; anyone can tap Skip (`skip`). `ms` resends match state to late joiners. Champion screen: podium, confetti, announcer.
- **Emotes:** 6 faces (Haha, Wow, Grr, Cool, Oops, Love), `emo` broadcast, max one per 2 s per player; they pop over the sender's runner and lobby row.
- **Versions:** the lobby flags players on an older `GAME_VERSION`. **Unity clients must use a different channel prefix (for example `headrush-u-room-`)** until cross-play with the web game has been tested on purpose. The web game is version 11.
- **Invite link:** `https://head-rush.vercel.app/?room=CODE` opens straight into that room on the web. For the app, set up an Android App Link for the same URL pattern so the app opens the room when installed (needs an `assetlinks.json` on the website: ask D first).
- **Known limitation to keep in mind:** hits are decided by each phone, not a server. Fine for family play; revisit if public matchmaking is ever added.

### Streak reminders
The web game uses web push (Supabase edge function `streak-reminder`, pg_cron hourly, sends at 7 pm Eastern "Your N-day streak ends at midnight" to opted-in players whose last play day was yesterday; see `supabase/streak_reminders.md`). **For the Android app this needs Firebase Cloud Messaging** (or a local scheduled notification, which needs no server). Recommend the local notification first; ask D.

---

## 8. Privacy and kids

The game is played by families, including kids.

- **Nickname only.** No email, phone, location, photos or contacts. No ads, no tracking.
- Name screen notice: "Your name and scores appear on the shared leaderboard. Use a first name or nickname, not your full name."
- **Privacy page** (port `privacy.html`): what's stored online (name, scores, level, round log, feedback, in the US on Supabase), what stays on the phone, who sees what, third parties, and how to delete.
- **Delete my data** in settings, with a confirm step: calls `delete_player`, then clears that player on the phone.
- **ALPHA** label until launch: "Alpha test: things may change, break or be reset." Web progress does **not** carry over to the app (it lives in the browser); say so in the alpha note.
- Before the public Google Play launch, the privacy wording gets a lawyer or privacy-policy service review (US children's privacy rules, COPPA). The privacy page becomes the store privacy policy and feeds the Play data safety form.

---

## 9. Milestones

Each milestone: build it, pass its checks, give D a debug APK and a test list, wait for OK.

### Milestone 1 — Core loop on Neon Rooftop
Unity project, URP, portrait, 60 fps target. `RoundSim` in plain C# with a fixed timestep. One runner, orange and blue bars, jump/duck with swipes and buttons, input buffer, hearts, stun, close shaves, 3-2-1 countdown, 90 s timer, simple results screen. Placeholder art.
**Checks:** sim numbers match section 2 (unit tests); swipes feel instant on D's phone; a jump at the last moment registers as a close shave.

### Milestone 2 — Bots, Party mode, all six arenas
7 bots with the section 2 behaviour, placing and win rules, all six arena twists (belts, lanes and walls, lava tiles, reverse and low gravity, hammers and blinking bars), arena picker.
**Checks:** a Party round plays out like the web version on each arena; Frost Peak lane switching works by tap, swipe and button.

### Milestone 3 — Difficulty, fairness and power-ups
Easy/Medium/Hard, speed-ups every 10 s, extra bars, **reaction-gap rule**, split and switch bars, power-ups, combo meter.
**Checks:** the 10-minute Hard Survival gap test passes; no "impossible" bar pairs in 20 test rounds.

### Milestone 4 — Modes and progression
Solo (18 levels, stars, unlocks), Survival (milestones, records), Daily Challenge (exact same pick as the web for a given date), streak with weekly freeze, daily goals, XP and levels, coins, Locker looks and shapes, perfect rounds and Perfect Gold, several players per phone, guided first round, Easy-first onboarding and tips.
**Checks:** for 5 sample dates the Unity daily challenge equals the web's `dailyFor()`; a new player can finish the guided round with no help.

### Milestone 5 — Art and audio
Final arena environments and runners (stylized 3D), lighting and bloom, quality tiers with auto-downgrade, announcer lines with priorities and ducking, arena music (or the licensed fallback), Music/Effects sliders, results celebration (count-up, confetti, level-up burst), knockout replay, haptics, reduced-motion support.
**Checks:** 60 fps on D's phone at High; stable 30 fps at Low on an older phone if one is available; music never clashes with the announcer.

### Milestone 6 — Online
Supabase client (REST + Realtime; pick a maintained C# Supabase library or plain `UnityWebRequest` for REST plus a WebSocket Realtime client; check what's current and tell D), player identity, leaderboard tabs, round log with offline queue, daily board, feedback form, Delete my data, privacy page, alpha label, Party Rooms with best-of-5 matches, bots in rooms, emotes, champion screen, invite links, share card and clip, streak reminder (local notification).
**Checks:** 4 phones (or 1 phone + 3 editor/emulator instances) play a full best-of-5 with no menu taps between rounds, every phone shows the same scores, a phone that drops and rejoins keeps its points; Delete my data removes the player's row and rounds.

### Milestone 7 — Google Play (closed test, then launch)
Signed Android App Bundle, app icon (reuse `icons/`), store listing, screenshots, privacy policy URL, data safety form, content rating, target audience settings (includes kids: follow the Families policy), closed testing track with family and friends.
**Checks:** installs from the Play closed test on D's phone; D approves before anything goes public.

### Later (not now)
iPhone build, public matchmaking, ranked play, cosmetics shop, seasons. Not before D asks.

---

## 10. Open decisions (D)

- [ ] Run `supabase/delete_player.sql` in the Supabase SQL editor (still missing as of Nov 1).
- [ ] Names to record for the announcer (10–15 family and friends), for "Aarna is out!"-style calls.
- [ ] Is the generated arena music good enough, or buy a licensed pack?
- [ ] Daily leaderboard: open to everyone, or friends only?
- [ ] Emote set: keep the current 6 faces, or ones the family picks?
- [ ] Final game name (Head Rush is still a working title).
- [ ] Keep improving the web version during the Unity build, or freeze it?

---

## 11. Reference map (web code)

| System | Where |
|---|---|
| Constants, arenas | `index.html` ~774–829 |
| Profiles, Supabase calls, round log, XP, daily goals | ~831–1010 |
| Daily Challenge, streak | ~1011–1105 |
| Solo levels, modes | ~1126–1141 |
| Difficulty table, `newRound()` | ~2514–2613 |
| Bars, split/switch, gap rule | ~2615–2677 |
| Moves, replay, sharing | ~2679–2872 |
| Power-ups, hits, combo | ~2881–2961 |
| Guided first round | ~2962–3069 |
| `update()`: speed-ups, bots, collisions | ~3070–3285 |
| Results and rewards (`showEnd`) | ~3735–3894 |
| Party Rooms, best-of-5, emotes | ~4275–4890 |
| Input, loop, push reminders, invites | ~4955–5143 |
| 3D renderer | `hd3d.js` |
| Music sequencer | `index.html` ~2293–2387 |
| Announcer | `index.html` ~2388–2462, `vo/` |
| Privacy page | `privacy.html` |
| Database notes | `supabase/` |

Line numbers are approximate; search for the function names if they've moved.
