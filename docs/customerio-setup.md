# Customer.io × PostHog wiring - Megapot Season 1

Everything the engine and app already send is listed in `crm-workflows.md`. This is the
click-path to turn `crm-content.md` + `email-templates/` into live campaigns.

## 0. Prereqs (done)
- Workspace keyed by **wallet id** (lowercase). `serve.py` identifies `email`, `email_bound`,
  `marketing_consent`, `privy_id` at email-bind; the engine writes the lifecycle attributes daily.
- Sending domain verified; test template sent OK.
- Reporting webhook → `https://app.hence.markets/api/hooks/customerio` (HMAC) → PostHog
  `cio_email_<metric>` events (sent/delivered/opened/clicked/unsubscribed), wallet-keyed.

## 1. Segments (Data & Segments → Segments → Create, "data-driven")
| name | conditions (AND) |
|---|---|
| `consent` | attribute `marketing_consent` is `true` AND `email` exists (MARKETING sends) |
| `has_email` | `email` exists (TRANSACTIONAL sends: C1, C3, C4, C5 - win/claim/mint alerts go out regardless of consent, as the rules promise) |
| `signed_up_no_trade` | `email_bound` = true AND `campaign_trade_days` = 0 AND `megapot_churned` is not `true` (wallet-only users are nudged in-app instead) |
| `active_trader` | `days_since_last_trade` ≤ 1 |
| `quiet_2d` / `quiet_4d` / `quiet_7d` | `days_since_last_trade` = 2 / = 4 / ≥ 7 AND `campaign_trade_days` ≥ 1 |
| `in_tonights_draw` | `tickets_in_draw` > 0 |
| `has_unclaimed` | `unclaimed_usd` > 0 |
| `winners` | `won_lifetime_usd` > 0 |
| `deep_streak` | `campaign_trade_days` ≥ 8 |
| `everyone_season` | `email_bound` = true |

## 2. Campaigns (Campaigns → Create)
For every campaign: **Trigger** as below, **Filter = `consent`** for marketing campaigns and
**Filter = `has_email`** (email exists only, NO consent condition) for the transactional ones
**C1, C3, C4, C5**; **Goal/exit = event `megapot_trade`** (except C which never exits), frequency
"one at a time", re-entry off unless stated.

| id | type | trigger | delay | template | extra exit |
|---|---|---|---|---|---|
| A | segment | enters `signed_up_no_trade` | A1 +24h → A2 +24h → A3 +24h → A4 +2d → A5 +2d | A1..A5 | A4 step = **webhook** to ops (see 4). (No hub-viewed skip: `megapot_hub_viewed` only reaches PostHog, so a Customer.io condition on it never evaluates.) |
| B1 | event | `megapot_activation_pack` | 0 | B1 | – |
| B2 | segment (recurring) | in `active_trader`, daily 08:00 UTC | 0 | B2 | max once per day |
| B3 | segment | enters `quiet_2d` | 0 | B3 | re-entry allowed after 7d |
| B4 | segment | enters `quiet_4d` | 0 | B4 | re-entry allowed after 7d |
| C1 | event | `megapot_tickets_minted` | 0 | C1 | transactional (`has_email`) |
| C2 | segment (recurring) | in `in_tonights_draw`, daily 15:00 UTC | 0 | C2 | once per day (dedupe on `megapot_status_at`) |
| C3 | event | `megapot_win_unclaimed` | 0 | C3 | transactional (`has_email`) |
| C4 | segment | in `has_unclaimed` for 24h | 24h | C4 | transactional (`has_email`); exit on `megapot_win_claimed` |
| C5 | event | `megapot_win_claimed` | 0 | C5 | transactional (`has_email`) |
| C6 | segment (recurring) | `tickets_lifetime` > 0, Mondays 09:00 UTC | 0 | C6 | weekly |
| D1 | segment | enters `quiet_7d` | 0 | D1 | re-entry after 7d |
| D2 | segment | `winners` AND `days_since_last_trade` ≥ 2 | 0 | D2 | once per season |
| D3 | broadcast | manual, season day 10, to `campaign_trade_days` ≥ 1 | – | D3 | – |
| D4 | broadcast | manual, final 48h, to `everyone_season` | – | D4 | – |
| D5 | broadcast | manual, season end +1d, to `everyone_season` | – | D5 | – |

## 3. Templates
Paste each `email-templates/<ID>.html` as a **Code** layout (not the visual editor), subject and
preheader from `crm-content.md`. Liquid is already in the HTML. From: `rewards@hence.markets`.
Test with a team wallet profile (attributes are live after one engine cycle). **In the test send,
verify the footer unsubscribe link resolves** - templates use `{% unsubscribe_url %}` (the tag
form); if the link renders literally, switch the footer to `{{ unsubscribe_url }}` in
`build-email-templates.py` and rebuild. Percentages use `| times: 100 | round`, and no template
uses `first_name` (nothing sets it).

## 4. The A4 free ticket (ops grant)
Step "webhook" in campaign A → `POST https://app.hence.markets/api/hooks/customerio/grant`
is NOT built; today the grant is manual: add `{ "id": "free-ticket-<wallet>", "wallet": "<wallet>",
"usd": 1 }` to `campaign.json → opsGrants` and redeploy the engine. The engine mints it, fires
`megapot_tickets_minted`, and the hub throws the welcome party. Ask for the webhook if A4
volume justifies it.

## 5. PostHog (project 359671)
- Engine events arrive with `source: megapot-engine`, app events from the hub, email metrics from
  the webhook - all on the same wallet `distinct_id`.
- Insights worth pinning: funnel `megapot_card_shown → megapot_activation_pack → megapot_trade
  (day 2)`; alert `megapot_engine_alert` any in 30 min; `megapot_tickets_minted` by `source` (buy vs retro); trend `megapot_streak_box` won vs empty by day; `cio_email_clicked` → `megapot_trade`
  within 24h per template (attribution).
- Nothing else to wire: the reporting webhook is the bridge.
