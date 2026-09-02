# Megapot Season 1 - CRM content (editable source)

Mirrors the CRM Playbook artifact. Edit here or export from the artifact; Liquid tags render in Customer.io. Flows/segments/triggers: docs/crm-workflows.md.

## A1 · A · T+24h · signed_up_no_trade
**Subject:** Here is what one trade gets you
**Preheader:** 1-5 Megapot tickets, tonight

You signed up. One trade of $100 on any asset - or $100 combined - and a pack of 1-5 Megapot tickets mints straight to your wallet for tonight's draw.

After that every $2,500 of volume fills the meter for another ticket, and every day you trade opens a streak box (day 2 pays 60% of the time).

The pool tonight: {{customer.pool_usd | default: "$1.1M"}}.

**Button:** See my first pack

## A2 · A · T+48h · signed_up_no_trade
**Subject:** {{customer.first_name | default: "Someone"}} in your cohort just minted 5 tickets
**Preheader:** They found alpha. You found the signup page.

A trader who joined the same week as you took the $100 pack, drew 5 tickets and is riding tonight's draw.

People are getting hilariously rich on a jackpot you have not entered yet. Your pack is still unopened.

**Button:** Place the trade

## A3 · A · T+72h · signed_up_no_trade
**Subject:** {{customer.minted_today | default: "23"}} tickets minted today. None of them yours.
**Preheader:** Draw closes 17:00 UTC

Today the pool wallet minted {{customer.minted_today | default: "23"}} Megapot tickets for Hence traders. The pool is {{customer.pool_usd | default: "$1.1M"}}.

You have 0 tickets in tonight's draw. One $100 trade fixes that in five minutes.

**Button:** Get in tonight's draw

## A4 · A · T+5d · ops grant free-ticket-{wallet}
**Subject:** We minted you a ticket. It rides tonight.
**Preheader:** On us - no trade needed

We put one Megapot ticket in your wallet for tonight's draw ({{customer.pool_usd | default: "$1.1M"}} pool). It is already yours.

Want more than one shot? A single $100 trade opens your 1-5 ticket pack next to it.

**Button:** See my ticket

## A5 · A · T+7d · last touch
**Subject:** Last one from us this season
**Preheader:** Your pack stays unopened

We will stop nudging. Your 1-5 ticket pack is still there for the length of Season 1 - one $100 trade opens it whenever you are ready.

**Button:** Open my pack

## B1 · B · on megapot_activation_pack
**Subject:** Your first pack: {{event.tickets}} tickets, riding tonight
**Preheader:** Welcome to the draw

Your first trade qualified. {{event.tickets}} Megapot tickets minted to your wallet and are in tonight's draw for {{customer.pool_usd | default: "$1.1M"}}.

From here every trade fills the meter, and tomorrow's trade opens streak box 2 - it pays 60% of the time.

**Button:** Watch the draw

## B2 · B · daily 08:00 UTC · active_trader
**Subject:** Box {{customer.next_box_day}} opens with today's trade
**Preheader:** {{customer.next_box_p | times: 100}}% chance of +{{customer.next_box_size}}

You are {{customer.campaign_trade_days}} days into the streak. Trade anything today and box {{customer.next_box_day}} opens: {{customer.next_box_p | times: 100}}% chance of +{{customer.next_box_size}} ticket{% if customer.next_box_size != 1 %}s{% endif %}.

Meter: {{customer.next_ticket_pct}}% to your next ticket - ${{customer.volume_to_next_ticket_usd}} more volume pops it.

**Button:** Trade today

## B3 · B · quiet_2d
**Subject:** You have been paid ${{customer.fee_rebated_usd}} to trade here
**Preheader:** The math on Hence during Season 1

Every fee you paid on Hence this season came back as Megapot tickets: ${{customer.fee_rebated_usd}} so far, {{customer.tickets_lifetime}} tickets.

Same trade anywhere else: same fee, zero tickets. Two quiet days means two unopened boxes.

**Button:** Trade cheaper than free

## B4 · B · quiet_4d
**Subject:** Four days. The people who kept going are ahead.
**Preheader:** A trader from your week just opened box 9

While you were away a trader who started the same week opened box 9 - 18% for +3 tickets. The boxes from day 11 hold 4 to 8.

Your next box is {{customer.next_box_day}}. It opens with one trade.

**Button:** Open my next box

## C1 · C · on megapot_tickets_minted
**Subject:** +{{event.count}} ticket{% if event.count != 1 %}s{% endif %} minted - draw #{{event.drawing}}
**Preheader:** {{event.todayTotal}} in tonight's draw

{{event.count}} Megapot ticket(s) just minted to your wallet. Draw #{{event.drawing}} closes 17:00 UTC; results land in the hub after.

Tonight you hold {{customer.tickets_in_draw}}.

**Button:** See my tickets

## C2 · C · daily 15:00 UTC · in_tonights_draw
**Subject:** {{customer.tickets_in_draw}} ticket{% if customer.tickets_in_draw != 1 %}s{% endif %} in tonight's draw
**Preheader:** Closes 17:00 UTC · pool {{customer.pool_usd | default: "$1.1M"}}

You have {{customer.tickets_in_draw}} Megapot ticket(s) in tonight's draw for {{customer.pool_usd | default: "$1.1M"}}.

One more trade before 17:00 UTC still counts for tomorrow's box ({{customer.next_box_p | times: 100}}% for +{{customer.next_box_size}}).

**Button:** Open the hub

## C3 · C · on megapot_win_unclaimed
**Subject:** You won ${{event.usd}}
**Preheader:** One signature pays it to your wallet

Ticket {{event.ticketId}} matched in draw #{{event.round}}: ${{event.usd}} is waiting. Claim it from the hub - one signature, paid in USDC to your wallet.

**Button:** Claim ${{event.usd}}

## C4 · C · +24h · has_unclaimed
**Subject:** ${{customer.unclaimed_usd}} is still sitting there
**Preheader:** Unclaimed winnings

You still have ${{customer.unclaimed_usd}} in unclaimed Megapot winnings. It does not expire, but it also does not compound. Claim it and put it back to work.

**Button:** Claim to my wallet

## C5 · C · on megapot_win_claimed
**Subject:** Paid: ${{event.usd}} in your wallet
**Preheader:** Winners trade again

${{event.usd}} landed in your wallet. Tonight's pool is {{customer.pool_usd | default: "$1.1M"}} and your next ticket is {{customer.next_ticket_pct}}% earned - ${{customer.volume_to_next_ticket_usd}} of volume pops it.

**Button:** Ride tonight's draw

## C6 · C · Mon 09:00 UTC · tickets_lifetime > 0
**Subject:** Your week: {{customer.tickets_lifetime}} tickets, ${{customer.fee_rebated_usd}} rebated
**Preheader:** Rewards accrued

This season so far: {{customer.tickets_lifetime}} tickets, ${{customer.won_lifetime_usd}} won, ${{customer.fee_rebated_usd}} of fees returned as tickets, {{customer.campaign_trade_days}} streak days.

Next up: box {{customer.next_box_day}} ({{customer.next_box_p | times: 100}}% for +{{customer.next_box_size}}) and {{customer.next_ticket_pct}}% of your next ticket.

**Button:** See the full stack

## D1 · D · quiet_7d
**Subject:** Your boxes are waiting
**Preheader:** {{customer.next_box_p | times: 100}}% for +{{customer.next_box_size}} on your next trade

A week without a trade. Your streak did not reset - boxes count trade days, not consecutive days - so box {{customer.next_box_day}} is still yours to open: {{customer.next_box_p | times: 100}}% chance of +{{customer.next_box_size}} tickets.

Pool tonight: {{customer.pool_usd | default: "$1.1M"}}.

**Button:** Open box {{customer.next_box_day}}

## D2 · D · winners, no trade 48h
**Subject:** You already won once
**Preheader:** Winners trade again

You have taken ${{customer.won_lifetime_usd}} out of Megapot this season. Every trade on Hence is another set of numbers in the draw - and your next ticket is {{customer.next_ticket_pct}}% earned.

**Button:** Trade again

## D3 · D · season day 10 · everyone with trade days ≥ 1
**Subject:** The big boxes open on day 11
**Preheader:** 4, 5, 6 and 8-ticket boxes

From day 11 the streak boxes hold 4, 5, 6 and 8 tickets. You are on {{customer.campaign_trade_days}} trade days. Every day you trade from here is a box you cannot get back.

**Button:** Keep the streak

## D4 · D · final 48h · everyone_season
**Subject:** Two draws left in Season 1
**Preheader:** Tickets minted after Sunday do not ride

Season 1 closes in 48 hours. Two draws left, {{customer.pool_usd | default: "$1.1M"}} in the pool, and any ticket you earn now still rides. Meter: {{customer.next_ticket_pct}}%.

**Button:** Trade before the close

## D5 · D · season end +1d · everyone_season
**Subject:** Season 1 recap - and ${{customer.unclaimed_usd}} to claim
**Preheader:** Your numbers

Season 1 is done. You: {{customer.tickets_lifetime}} tickets, {{customer.campaign_trade_days}} streak days, ${{customer.won_lifetime_usd}} won. {% if customer.unclaimed_usd > 0 %}${{customer.unclaimed_usd}} is still unclaimed - one signature.{% endif %}

Season 2 details land here first.

**Button:** Claim and see my recap

