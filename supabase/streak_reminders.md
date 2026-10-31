# Streak reminders (Phase 6) — applied 2026-10-30

- `push_subs` table (one row per player, cascades on player delete), RLS on with no policies.
- `save_push(p_id, p_secret, p_sub, p_on, p_streak, p_last)` — secret-checked upsert called by the game.
- VAPID keys and a cron secret live in Supabase Vault (`headrush_vapid_private`, `headrush_vapid_public`, `headrush_cron_secret`);
  `headrush_push_config()` reads them and is executable by `service_role` only.
- Edge function `streak-reminder` (verify_jwt off, checks the `x-cron-secret` header). At 7 pm America/New_York it sends
  "Your N-day streak ends at midnight" to opted-in players whose last play day was yesterday. Expired subscriptions are switched off.
- pg_cron job `headrush-streak-reminder` calls it at minute 2 of every hour via pg_net; the function itself decides whether it is 7 pm Eastern.
- To pause reminders: `select cron.unschedule('headrush-streak-reminder');`
