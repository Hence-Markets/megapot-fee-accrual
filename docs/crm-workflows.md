# Megapot Season 1 - CRM workflows (Customer.io)

Profiles are keyed by **wallet** (lowercase). `serve.py` attaches `email`,
`email_bound`, `marketing_consent`, `privy_id` at email-bind; the engine keeps
the lifecycle attributes fresh (below). Every engine event also lands in
PostHog (project 359671) with `source: megapot-engine`.

## Events (engine -> Customer.io + PostHog)

| event | when | key props |
|---|---|---|
| `megapot_trade` | each 5-min cycle with qualifying volume | `usd`, `fills`, `feeRebatedUsd`, `creditUsd`, `nextTicketPct`, `campaignTradeDays`, `dateUtc` |
| `megapot_activation_pack` | first qualifying trade ($250 single or combined) | `tickets` (1-5), `qualifyingUsd` |
| `megapot_tickets_minted` | every on-chain buy | `count`, `txHash`, `drawing`, `priceUsd`, `todayTotal`, `creditLeftUsd` |
| `megapot_streak_box` | each new distinct trade day | `day`, `won`, `tickets`, `p`, `size`, `nextDay`, `nextP`, `nextSize` |
| `megapot_streak_day` | each new distinct trade day (legacy anchor) | `dateUtc`, `dayOfWeekCount`, `weekVolumeUsd` |
| `megapot_daily_status` | once per UTC day per wallet, and again when draw count / claimable money changes | `ticketsInDraw`, `ticketsLifetime`, `unclaimedUsd`, `wonLifetimeUsd`, `creditUsd`, `nextTicketPct`, `volumeToNextTicketUsd`, `feeRebatedUsd`, `volumeUsd`, `campaignTradeDays`, `lastTradeAt`, `daysSinceLastTrade`, `nextBoxDay/P/Size` |
| `megapot_win_unclaimed` | a ticket has winnings, not claimed | `usd`, `round`, `ticketId` |
| `megapot_win_claimed` | that ticket got claimed | `usd`, `round`, `ticketId` |
| `megapot_email_bound` (serve.py -> PostHog) + identify | email linked in the hub | `marketing_consent` |

## Profile attributes (refreshed with `megapot_daily_status`)
`tickets_in_draw`, `tickets_lifetime`, `unclaimed_usd`, `won_lifetime_usd`,
`next_ticket_pct`, `volume_to_next_ticket_usd`, `fee_rebated_usd`,
`campaign_volume_usd`, `campaign_trade_days`, `last_trade_at`,
`days_since_last_trade`, `next_box_day`, `next_box_p`, `next_box_size`,
`megapot_status_at`.

## Daily updates (the three the brief asked for)
1. **"{x} tickets in tonight's draw"** - trigger: `megapot_daily_status` with
   `ticketsInDraw > 0`; send window 15:00-16:30 UTC (draw closes 17:00 UTC).
   Skip if the wallet already got one today (use `dateUtc` as the dedupe key).
2. **"Winnings ready to claim"** - trigger: `megapot_win_unclaimed`;
   reminder after 24h if attribute `unclaimed_usd > 0`; exit on
   `megapot_win_claimed`.
3. **"Rewards accrued"** (weekly digest or on threshold) - trigger:
   `megapot_daily_status`; body uses `feeRebatedUsd`, `nextTicketPct`,
   `volumeToNextTicketUsd`, `campaignTradeDays`, `nextBoxP/Size`.

## The activation workflow (the whiteboard diagram)

Entry: profile has `email_bound = true` (identify from the hub). Branch on
**"user trades"** = event `megapot_trade` received (any amount); every node
below exits the moment that event arrives and re-enters the *trader* track.

### Track A - signed up, no trade
| step | wait | trigger / segment | message |
|---|---|---|---|
| A1 | +24h no `megapot_trade` | `campaign_trade_days = 0` | "Check how many tickets you'd get" - the $250 pack (1-5 tickets) + the meter: "$2,500 of volume = 1 ticket, every day a streak box" |
| A2 | +48h | still 0 | Testimonial: user A found alpha / people are getting hilariously rich and you are not |
| A3 | +72h | still 0 | Ragebait (leaderboard / pool size / "N traders minted tickets today" - use PostHog daily mint count) |
| A4 | +5d | still 0 | Offer a free Megapot ticket: ops grant (`OPS_GRANTS` in campaign.json, id `free-ticket-<wallet>`) - the engine mints it next cycle, `megapot_tickets_minted` fires, the hub replays the welcome party |
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
- Sends require `marketing_consent = true` (segment condition on every campaign).
- One daily-status email per UTC day per wallet (dedupe on `dateUtc`).
- All engine comms are fail-open: a Customer.io outage never blocks minting.
