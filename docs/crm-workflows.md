# Megapot Season 1 - CRM workflows (Customer.io)

Profiles are keyed by **wallet** (lowercase). `serve.py` attaches `email`,
`email_bound`, `marketing_consent`, `privy_id` at email-bind; the engine keeps
the lifecycle attributes fresh (below). Every engine event also lands in
PostHog (project 359671) with `source: megapot-engine`; hub events arrive from
the browser, email metrics from the Customer.io reporting webhook.

Numbers in the copy come from `campaign.json` (pack on a **$100** first trade,
$250/day for a box, 0.04% of volume). Do not restate them here; link the sheet.

## Events (engine -> Customer.io + PostHog)

| event | when | key props |
|---|---|---|
| `megapot_trade` | each 5-min cycle with qualifying volume | `usd`, `fills`, `feeRebatedUsd`, `creditUsd`, `nextTicketPct`, `campaignTradeDays`, `dateUtc` |
| `megapot_activation_pack` | first qualifying trade (`firstTradeBonus.minTradeUsd` = $100, single or combined) | `tickets` (1-5), `qualifyingUsd` |
| `megapot_pack_held` | pack qualified but not granted this cycle (daily pack gate full, pool empty, or `PACK_REQUIRES_EMAIL` unmet) - re-evaluated next cycle | `reason`, `qualifyingUsd` |
| `megapot_tickets_minted` | every on-chain buy **or retro transfer** | `count`, `txHash`, `drawing`, `priceUsd`, `todayTotal`, `creditLeftUsd`, `source` (`buy` \| `retro`) |
| `megapot_streak_box` | each new distinct trade day (>= `streakBox.minDayUsd`) | `day`, `won`, `tickets`, `p`, `size`, `nextDay`, `nextP`, `nextSize` |
| `megapot_streak_ticket` | a box grant credited (after the daily box gate) | `day`, `tickets`, `poolLeft` |
| `megapot_streak_day` | each new distinct trade day (legacy anchor) | `dateUtc`, `dayOfWeekCount`, `weekVolumeUsd` |
| `megapot_daily_status` | once per UTC day per wallet, and again when draw count / claimable money changes | `ticketsInDraw`, `ticketsLifetime`, `unclaimedUsd`, `wonLifetimeUsd`, `creditUsd`, `nextTicketPct`, `volumeToNextTicketUsd`, `feeRebatedUsd`, `volumeUsd`, `campaignTradeDays`, `lastTradeAt`, `daysSinceLastTrade`, `nextBoxDay/P/Size`, `poolUsd` (number), `poolLabel` |
| `megapot_win_unclaimed` | a ticket has winnings, not claimed | `usd`, `round`, `ticketId` |
| `megapot_win_claimed` | that ticket got claimed | `usd`, `round`, `ticketId` |
| `megapot_engine_alert` | ops only (PostHog): pool wallet below threshold, feed empty/shrunk, fee above cap, reconcile anomaly. Mirrors a `[megapot] ALERT …` log line; `megapot-watch` reads those | `kind`, `detail`, `target` |

### App events (serve.py / hub -> PostHog; some also identify in Customer.io)

| event | source | when | key props |
|---|---|---|---|
| `megapot_email_bound` (+ identify) | serve.py | verified email linked in the hub | `marketing_consent` |
| `megapot_email_captured_unverified` | hub | email typed into the gate, not yet verified | `campaign` |
| `megapot_hub_viewed` | hub | Reward Hub opened (PostHog only - NOT a Customer.io condition, see customerio-setup.md) | `packPending`, `lifetime` |
| `megapot_cta_clicked` | hub | primary meter CTA | `where` |
| `megapot_card_shown` / `megapot_card_clicked` / `megapot_card_dismissed` | hub | new-user campaign card | `campaign`, `from` |
| `megapot_banner_clicked` / `megapot_banner_dismissed` | hub | top campaign banner | `campaign`, `from` |
| `cio_email_sent` / `cio_email_delivered` / `cio_email_opened` / `cio_email_clicked` / `cio_email_unsubscribed` | Customer.io reporting webhook via serve.py | per email metric, wallet-keyed | `campaign_id`, `template` |

## Profile attributes (refreshed with `megapot_daily_status`)
`tickets_in_draw`, `tickets_lifetime`, `unclaimed_usd`, `won_lifetime_usd`,
`next_ticket_pct`, `volume_to_next_ticket_usd`, `fee_rebated_usd`,
`campaign_volume_usd`, `campaign_trade_days`, `last_trade_at`,
`days_since_last_trade`, `next_box_day`, `next_box_p`, `next_box_size`,
`minted_today`, `pool_usd` (**numeric**, for segments), `pool_label`
(formatted, e.g. `$1.1M`, for copy), `megapot_status_at`.

Snapshot cadence: once per UTC day plus on change. Copy that shows "today"
numbers must prefer **event** props (`{{event.todayTotal}}`) over attributes.

## Daily updates (the three the brief asked for)
1. **"{x} tickets in tonight's draw"** - trigger: `megapot_daily_status` with
   `ticketsInDraw > 0`; send window 15:00-16:30 UTC (draw closes 17:00 UTC).
   Skip if the wallet already got one today (use `dateUtc` as the dedupe key).
2. **"Winnings ready to claim"** - trigger: `megapot_win_unclaimed`;
   reminder after 24h if attribute `unclaimed_usd > 0`; exit on
   `megapot_win_claimed`. **Transactional**: sends on email-exists, not consent.
3. **"Rewards accrued"** (weekly digest or on threshold) - trigger:
   `megapot_daily_status`; body uses `feeRebatedUsd`, `nextTicketPct`,
   `volumeToNextTicketUsd`, `campaignTradeDays`, `nextBoxP/Size`.

## The activation workflow (the whiteboard diagram)

Entry: event `megapot_trade` received **OR** profile has `email_bound = true`.
Email is optional in Season 1, so wallet-only users enter on their first trade
event; the in-app card and banner (`megapot_card_*`, `megapot_banner_*`) are
the pre-trade nudge for them. Branch on **"user trades"** = event
`megapot_trade` (any amount); every node below exits the moment that event
arrives and re-enters the *trader* track.

### Track A - signed up (email), no trade
| step | wait | trigger / segment | message |
|---|---|---|---|
| A1 | +24h no `megapot_trade` | `campaign_trade_days = 0` | "Check how many tickets you'd get" - the $100 pack (1-5 tickets) + the meter: "$2,500 of volume = 1 ticket, every day a streak box" |
| A2 | +48h | still 0 | Testimonial: a trader in your cohort minted 5 tickets |
| A3 | +72h | still 0 | Ragebait (pool size / "N tickets minted today" - `minted_today`) |
| A4 | +5d | still 0 | Offer a free Megapot ticket: ops grant (`opsGrants` in campaign.json, id `free-ticket-<wallet>`) - the engine mints it next cycle, `megapot_tickets_minted` fires, the hub replays the welcome party |
| A5 | +7d | still 0 | Churn - tag `megapot_churned = true`, stop sends |

### Track B - trader
| step | trigger | message |
|---|---|---|
| B1 | `megapot_activation_pack` | "Your first pack: N tickets - riding tonight" |
| B2 | daily, `megapot_daily_status` with `daysSinceLastTrade = 0` | "Trade every day for more tickets" - tomorrow's box odds (`nextBoxP`, `nextBoxSize`) |
| B3 | `days_since_last_trade >= 2` | "The math": `fee_rebated_usd` so far, effective fee after rebate, `volume_to_next_ticket_usd` |
| B4 | `days_since_last_trade >= 4` | Testimonial (same asset as A2) |
| B5 | `megapot_trade` at any point | back to B2 |

### Ticket lifecycle track (parallel, all users with tickets)
`megapot_tickets_minted` -> "minted, in draw #N" (same-day) ->
`megapot_daily_status` 15:00 UTC digest -> `megapot_win_unclaimed` -> claim
nudge (+24h reminder) -> `megapot_win_claimed` -> "paid to your wallet".

## Guardrails
- **Marketing** sends (A, B2-B4, C2, C6, D) require `marketing_consent = true`.
- **Transactional** sends (C1 minted, C3 win unclaimed, C4 claim reminder, C5 claimed)
  require only `email` exists - the rules promise win alerts regardless of consent.
- Wallet-only users (no email) get every win/claim surface in-app (hub unclaimed-wins
  panel); nothing is lost, only the email leg is absent.
- One daily-status email per UTC day per wallet (dedupe on `dateUtc`).
- All engine comms are fail-open: a Customer.io outage never blocks minting.
- No PII in PostHog props (wallet ids only); email lives in Customer.io.
