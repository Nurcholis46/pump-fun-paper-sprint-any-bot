# Pump.fun Paper Sprint — Fresh-Launch Momentum Sniper

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Nurcholis46/pump-fun-paper-sprint-any-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Nurcholis46/pump-fun-paper-sprint-any-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2, free entry). The bot trades pump.fun bonding curves on the house's 6-hour replay; highest net PnL wins.

## Strategy

Fresh-launch momentum sniper with tight risk — most pump.fun coins die within
minutes of launch, but the ones that survive the first few slots with genuine
outside buying often run 8–30% before early buyers take profit. The bot only
buys launches that look alive, sizes every bet the same small amount, and gets
out fast either way.

**Entry** (first buy only, no averaging down) — coin is 0–4 slots old, real SOL
in the curve is 0.3–30 SOL, creator's own create-slot buy ≤ 2.5 SOL, 1–3
distinct non-creator buyers already in, creator has not sold, no single
non-creator sell bigger than 3% of the reserve, price ≤ 15% above create price,
net SOL flow over the last 10 slots not negative.

**Exits** — partial take-profit (sell half at +6%), full take-profit at +8%,
stop-loss at −5% (after the partial, the rest stops at cost), trailing stop
(arms at +6%, exits on a 5% pullback from the best value), 60-slot max hold,
immediate exit if the creator sells, stale exit after 120 slots without a trade.

**Risk** — 0.05 SOL per coin (capped by the harness's 1%-of-real-reserve rule),
max 5 open positions, every round trip ≥ 0.01 SOL across dozens of coins (the
20-distinct-mints bar is cleared with room to spare). Worst case per coin is
the −5% stop plus fees, so a run of losers cannot approach the 50%
max-drawdown guardrail.

## Files

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`); wires the strategy into the replay protocol.
- `strategy.ts` — the strategy (pure function of the batches it is fed: no clock, no randomness, no I/O).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim (`sdk/ts/makefun-bot.ts`), vendored byte for byte.

## Honest backtest (dev window, `grade-local --driver process`)

On the kit's full dev dataset (24h, 128,058 events — the same grading the
server runs, two executions, byte-for-byte reproducible):

| metric | value |
|---|---|
| Net PnL | **−0.0855 SOL** (return −0.86%; 90% interval −0.112 … −0.058 SOL) |
| Max drawdown | 0.88% |
| Coins traded | 106 (all with a round trip ≥ 0.01 SOL — guardrails met) |
| Fills / round trips | 221 / 106 |
| Win rate (per round trip) | 13.2% |
| Fees | 0.039 SOL curve + 0.024 SOL tx (net at 2× fees: −0.148 SOL) |
| Rejected orders | 0 (10 failed txs, the seeded ~2% failure draw) |

The dev window is a hard one for this strategy family — the house sniper
baseline loses −0.138 SOL and the momentum baseline −9.38 SOL on the same
data (local sim slice). This bot loses the least of the three, with the
smallest drawdown, by keeping stakes small and exits tight; four parameter
variants tried on the full dev window all landed within −0.075 … −0.097 SOL,
so no tuning turns this window positive — the edge, if any, is in the final
window's fresh launches. The final window is a fresh 6 hours of real market
data, so dev numbers are a guide, not a promise: on a window where a few
launches actually run, the +8% take-profits and the trailing stop are what pay.

## Run it

```sh
node main.ts
```

Graded locally with the kit (`grade-local --driver process`); see the entry's
grade report for the authoritative dev score.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mt29fv3h&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
