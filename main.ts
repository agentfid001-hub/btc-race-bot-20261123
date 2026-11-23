// Washout-rebound bot for make.fun btc-race-24h-20261123-0511.
//
// One asset, CBBTC (Coinbase Wrapped BTC on Solana), $1,000 of paper money,
// 1,440 one-minute bars. A full round trip costs about 26 bps (4 bps fee +
// 2 bps slippage + ~7 bps of price impact per side), while one-minute noise
// is only ~6 bps, so anything that trades often pays the pool more than it
// can catch. This bot therefore waits for a real washout and trades it at
// most once or twice, then goes quiet.
//
// How it decides (all thresholds tuned on two real 24-hour dev windows plus
// 60 synthetic windows across six regimes, with an exact fill model that
// reproduces the official grade of the earlier Dip Buyer entry to the cent):
//
//   ENTRY — a washout with a bounce:
//     * the latest close is at least 1.20% below the close 30 bars earlier
//       (a sharp half-hour washout; a 30-bar window reacts sooner than an
//       hour-long one, and 1.20% is ~3.5x the 30-bar noise so random chop
//       rarely trips it), AND
//     * the last two closes both ticked up (close[t] > close[t-1] >
//       close[t-2]): the fall has actually turned, instead of buying into
//       a knife that is still falling. The winners of the previous race all
//       entered on a bounce like this; buying mid-fall is what left the
//       earlier entry holding a position it could not exit.
//     * buys with all cash.
//
//   EXIT — whichever comes first:
//     * TAKE PROFIT +1.80% above the close the buy was decided on.
//     * STOP LOSS -1.50% below that close. After a stop-out the bot will
//       not buy another washout for 480 bars: a stop means the washout was
//       a falling knife, and buying the same falling market again is how
//       the earlier backtests turned one -$15 loss into three.
//     * CUT: if the position is still below its entry close after 180 bars
//       held, sell. A dip that has not recovered in three hours is a grind,
//       not a bounce; the earlier entry bled -$48 on exactly this shape
//       by waiting 480 bars for a stale exit that never came in time.
//     * STALE: sell after 480 bars held, whatever the price.
//     * FORCED: sell at bar 1400 no matter what, so every position is out
//       before the window ends. A buy with no exit is the 1-trade trap:
//       176 of 177 one-trade entries in the previous race lost money,
//       because the end-of-window flatten sold them at a loss.
//
//   LATE-WINDOW RULES:
//     * No new washout buys after bar 1380.
//     * FALLBACK: if no round trip has completed by bar 1200, buy at bar
//       1200 anyway, with a small +0.50% target and the same forced exit.
//       A window with no washout at all (the dev window of this race rises
//       3.64% and its deepest 60-bar drop is only -1.34%) would otherwise
//       end with zero trades, which fails both the dev gate (net PnL must
//       be above $0) and the race guardrail (>= 1 trade). One small planned
//       trade beats none; across the tuning windows this fallback loses at
//       most about $2.50 and usually makes about $2.
//
// What the tuning says, honestly: on the two older real windows this bot
// makes +$14.95 and +$12.98; on this race's dev window +$5.20 (fallback
// trade only — the window never washouts hard enough to arm the main
// trigger); across 60 synthetic windows the median is +$1.92, 38 of 60
// positive, worst -$18.41. The dev window is rising, so the race window
// is a coin flip; the design buys the dip if one comes and otherwise
// banks the small fallback trade instead of sitting on $0.
//
// Protocol: agent-fun/bars-replay/v1 through the kit's TypeScript shim
// (vendor/makefun-bars.ts, a byte-identical copy of sdk/makefun-bars.ts).
// Bigint prices only, no floats, no clock, no network, no files, no
// randomness: two runs on the same bars send the same orders.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;

// --- entry: washout + two-uptick bounce ----------------------------------
const WASHOUT_BPS = 120n; // close >= 1.20% below the close 30 bars earlier
const WASHOUT_BARS = 30;
// --- exits ---------------------------------------------------------------
const TAKE_PROFIT_BPS = 180n; // sell everything at +1.80% over entry close
const STOP_LOSS_BPS = 150n; // sell everything at -1.50% under entry close
const STOP_COOLDOWN_BARS = 480; // no washout buys for this long after a stop
const CUT_BARS = 180; // sell if still under water after this many bars held
const STALE_BARS = 480; // sell after this many bars held, whatever the price
const FORCED_EXIT_BAR = 1400; // sell at this bar no matter what
const NO_BUY_AFTER = 1380; // no new washout buys this late
// --- fallback (guardrail insurance) --------------------------------------
const FALLBACK_BAR = 1200; // buy here if no round trip has completed yet
const FALLBACK_TP_BPS = 50n; // the fallback's small target: +0.50%
// Orders are refused if the next open moved more than 1% past the close
// the decision was made on; a refused order is retried on the next bar.
const MAX_SLIPPAGE_BPS = 100;

// Integer closes (price scale 5), one entry per fresh bar, in order.
const closes: bigint[] = [];
// The open position's entry, set only once its buy is observed filled:
// a buy refused for slippage must leave no stale entry behind.
let entryClose = 0n;
let entryBar = -1;
let entryIsFallback = false;
// A buy just ordered but not yet seen filled: promoted into the entry
// fields on the first batch that shows the position.
let pendingClose = 0n;
let pendingBar = -1;
let pendingFallback = false;
// Round trips completed so far; the fallback only fires while this is 0.
let roundTrips = 0;
// No washout buys before this bar (set when a stop-loss fires).
let coolUntil = -1;
// A sell just ordered but not yet seen filled: only once the position is
// observed gone do the exit's books close (round trip counted, entry
// cleared, stop cooldown applied). A sell refused for slippage simply
// leaves the position held, and the exit is decided again next bar.
let exitOrdered = false;
let exitWasStop = false;

function twoUpticks(): boolean {
  const n = closes.length;
  return n >= 3 && closes[n - 1] > closes[n - 2] && closes[n - 2] > closes[n - 3];
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }
    if (state.warmingUp) return [];
    if (closes.length <= WASHOUT_BARS) return [];
    const barIndex = closes.length - 1;
    const price = closes[barIndex];
    const held = state.positions.get(SYMBOL);

    if (held === undefined) {
      // A sell ordered last bar has filled: close its books now.
      if (exitOrdered) {
        exitOrdered = false;
        if (exitWasStop) coolUntil = barIndex + STOP_COOLDOWN_BARS;
        exitWasStop = false;
        roundTrips += 1;
        entryClose = 0n;
        entryBar = -1;
        entryIsFallback = false;
      }
      // Flat: look for a buy. The fallback outranks the washout trigger
      // and is exempt from the late-window buy ban: it is the guardrail
      // insurance, and bar 1200 still leaves 200 bars for its exit.
      if (roundTrips === 0 && barIndex >= FALLBACK_BAR && barIndex < NO_BUY_AFTER) {
        pendingClose = price;
        pendingBar = barIndex;
        pendingFallback = true;
        const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [order];
      }
      if (barIndex >= NO_BUY_AFTER || barIndex < coolUntil) return [];
      const halfHourAgo = closes[barIndex - WASHOUT_BARS];
      const washedOut = price * BPS <= halfHourAgo * (BPS - WASHOUT_BPS);
      if (washedOut && twoUpticks()) {
        pendingClose = price;
        pendingBar = barIndex;
        pendingFallback = false;
        const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [order];
      }
      return [];
    }

    // Long: promote the pending entry once the buy is observed filled.
    if (entryClose === 0n) {
      entryClose = pendingClose;
      entryBar = pendingBar;
      entryIsFallback = pendingFallback;
      pendingClose = 0n;
      pendingBar = -1;
      pendingFallback = false;
    }
    const targetBps = entryIsFallback ? FALLBACK_TP_BPS : TAKE_PROFIT_BPS;
    const tookProfit = price * BPS >= entryClose * (BPS + targetBps);
    const stoppedOut = price * BPS <= entryClose * (BPS - STOP_LOSS_BPS);
    const cutLoss = barIndex - entryBar >= CUT_BARS && price < entryClose;
    const stale = barIndex - entryBar >= STALE_BARS;
    const forced = barIndex >= FORCED_EXIT_BAR;
    if (tookProfit || stoppedOut || cutLoss || stale || forced) {
      // Order the exit; its books close only once the fill is observed.
      exitOrdered = true;
      exitWasStop = stoppedOut && !tookProfit;
      const order: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [order];
    }
    return [];
  },
});
