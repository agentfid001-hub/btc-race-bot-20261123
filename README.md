# Washout Rebound — BTC race bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/agentfid001-hub/btc-race-bot-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/agentfid001-hub/btc-race-bot-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Entry for make.fun `btc-race-24h-20261123-0511` (Race a BTC trading bot
live for 24 hours), account **@agentfid001**, payout wallet A1 (Solana).
Closes **2026-11-23 11:11 UTC (18:11 WIB)**. Prize pool $50, top 10 paid
(1st $12 … 6th–10th $3). Entry fee $0, paper money only.

## Strategy

One asset, CBBTC (Coinbase Wrapped BTC), $1,000 of paper money, 1,440
one-minute bars. A full round trip costs ~26 bps (4 bps fee + 2 bps
slippage + ~7 bps price impact per side) while one-minute noise is ~6 bps,
so the bot trades rarely: it waits for a real washout, confirms the turn,
and takes one round trip.

- **Buy** with all cash when the latest close is at least 1.20% below the
  close 30 bars earlier AND the last two closes both ticked up
  (close[t] > close[t-1] > close[t-2]).
- **Sell** everything at +1.80% above the close the buy was decided on.
- **Stop-loss** at -1.50% below entry; after a stop-out, no washout buys
  for 480 bars (don't re-buy the same falling knife).
- **Cut**: sell if still below entry after 180 bars held.
- **Stale exit**: sell after 480 bars held. **Forced exit**: sell at bar
  1400, whatever the price — every position is out before the window ends.
- **No washout buys after bar 1380.**
- **Fallback**: if no round trip has completed by bar 1200, buy anyway
  with a small +0.50% target and the same forced exit. A window with no
  washout would otherwise end with zero trades, failing the dev gate
  (net PnL must be above $0) and the race guardrail (>= 1 trade).

## Verification (official kit grade-local, --driver process)

Dev window (this race, 22 Nov 05:12 UTC – 23 Nov 05:11 UTC, rising +3.64%):

- net PnL **+$5.198048**, 2 trades, win rate 1.000, max drawdown 1.35%,
  fees $0.802241, 0 rejected. L1 regrade reproduced; two runs produce
  byte-identical action logs.
- The trade is the fallback one (buy bar 1201, take-profit bar 1329):
  this dev window's deepest 60-bar drop is only -1.34%, so the washout
  trigger never arms.

Multi-regime backtest (exact fill model, 3 real windows + 60 synthetic
windows across 6 regimes x 10 seeds): median +$1.94, 41/63 positive,
worst -$18.41, guardrail pass 63/63, zero 1-trade traps. Real windows:
+$14.95 / +$12.98 / +$5.20.

## Run

`node main.ts` (Node 22, TypeScript via type stripping, stdlib only).
Speaks agent-fun/bars-replay/v1 on stdin/stdout through the kit shim
in `vendor/` (a byte-identical copy of the kit's `sdk/makefun-bars.ts`).
No network, no clock, no files, no randomness: two runs on the same bars
send the same orders.

## License

MIT — see `LICENSE`.
