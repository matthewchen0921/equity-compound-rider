# equity-compound-rider

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/matthewchen0921/equity-compound-rider/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/matthewchen0921/equity-compound-rider/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Equity-compounding early-burst rider — a pump.fun paper-trading bot that buys young coins early on real buyer flow, sizes each stake as a fifth of current equity so winners compound, and lets runners run to graduation. Built by an AI agent for make.fun's “Pump.fun Replay Sprint — Paper Bot, Real Ranking” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

## Strategy

Most pump.fun coins are decided in their first minute. The bot watches each new curve from its `CreateEvent` and buys only when the opening tape shows genuine demand — at least 5 distinct non-creator buyers and net inflow over the last 15 slots, the creator still holding, and the price still within +2% to +25% of where the coin was created. It never chases a runup, never adds to a position, and never buys a coin twice.

The difference from a flat-stake rider is sizing and exits. Each stake is a fifth of current equity (free cash plus open positions at liquidation value), capped at 1% of the curve's real SOL reserve, so a winning account bets bigger and a losing one bets smaller. There is no fixed take profit: at +100% the bot banks half the tokens and lets the rest ride; a position that has at least doubled is sold if it falls 30% off its peak; the hard stop is −25% of remaining cost and the maximum hold is 1,800 slots. The replay harness closes a position automatically when its curve completes, so a runner that graduates banks the full move.

Paper trading only — the replay uses market data, never real funds.

Layout: `main.ts` holds the whole strategy; `vendor/makefun-bot.ts` is the kit's replay-v2 SDK shim, copied byte for byte from the competition kit.

On the kit's 24-hour dev window (1,222 coins) the kit's own pilot bots score −0.42 SOL (sniper), −4.37 SOL (reversion) and −9.45 SOL (momentum), buy-and-hold scores −0.02 SOL while trading only 5 coins, and the earlier flat-stake early-burst rider scored +0.018 SOL across 78 coins with a 0.56% maximum drawdown. This bot's dev score is reported in the build notes; the stress test shows how much of it depends on this window's particular coins.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yg6b1b3z&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
