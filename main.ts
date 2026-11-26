// Equity-compounding early-burst rider for the pump.fun paper sprint
// (agent-fun/replay/v2, Node 22).
//
// The dev window is the same 24 hours the boothlord sprint graded on, and
// the lesson from that window is twofold. First, the entry edge is real
// but small: a coin that opens with several distinct buyers piling in, net
// SOL flowing in, and the creator still holding is worth a stake — but
// only while its price is still close to creation (entries past +25% over
// the creation price lose money; the flat 0.05 SOL stakes of the earlier
// rider scored +0.018 SOL across 78 coins). Second, the upside on this
// window is a fat tail, not a steady drift: a flat stake with a +50% take
// profit caps every winner at +0.025 SOL, while a handful of coins run
// 5-50x to graduation. So this bot keeps the same early-burst entry
// filter, but sizes each stake as a fifth of current equity (winners
// compound: stakes grow as the account grows) and lets runners run —
// no fixed take profit, a half-position bank at +100%, and only a 30%
// trailing stop once a position has at least doubled. The harness closes
// a position automatically when its curve completes (graduation), so a
// runner that makes it all the way banks the full move.
//
// Guardrails are sized to survive: five positions at most, each at most
// a fifth of equity, each cut at -25% of its remaining cost, so the worst
// simultaneous loss is about a quarter of equity — far inside the 50%
// drawdown limit. One buy per coin, no pyramiding, no re-entry.
//
// Deterministic by construction: no clock, no randomness, no environment,
// iteration only over insertion-ordered maps fed by the batch stream, so
// the two graded executions produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Age (slots since CreateEvent) inside which a first buy may be decided. */
const ENTRY_MAX_AGE = 60;
/** Slots of opening tape a buy is judged on. */
const TAPE_SLOTS = 15;
/** Trades seen in the tape window before a coin may be bought. */
const TAPE_MIN_TRADES = 3;
/** Distinct non-creator buyers seen in the tape window. */
const TAPE_MIN_BUYERS = 5;
/** Net SOL bought over the tape window (SOL). */
const TAPE_MIN_NET_SOL = 0.05;
/** Buy window: price now over the creation price. */
const RUNUP_MIN = 0.02;
const RUNUP_MAX = 0.25;
/** Stake as a share of current equity (cash + open positions at value). */
const STAKE_SHARE_NUM = 1;
const STAKE_SHARE_DEN = 5;
/** Smallest buy worth paying the transaction fee for. */
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/** Sell the whole position once it is worth this far under its cost. */
const STOP_LOSS = 0.25;
/** Bank half the tokens once the position is worth this much over cost. */
const BANK_AT = 1.0; // +100%
/** Sell a doubled position once it falls this far below its best value. */
const RUNNER_TRAIL = 0.30;
/** Sell once the position is this old (slots since its buy filled). */
const MAX_HOLD = 1800;
/** Curve fee on each side (protocol 95 bps + creator 30 bps). */
const FEE_BPS = 125;
/** Slippage allowed on every order: fills are never refused for the price moving in the latency. */
const SLIPPAGE_BPS = 10_000;

// ------------------------------------------------------------------ tape state

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
}

interface CoinTape {
  createdSlot: number | null;
  createPrice: number;
  creator: Pubkey;
  creatorSold: boolean;
  complete: boolean;
  trades: Trade[];
}

/** What the bot remembers about a position it holds. */
interface Open {
  buySlot: number;
  /** Cost of the tokens still held. Halves when half the position is banked. */
  basis: bigint;
  /** Best liquidation value seen for the tokens still held. */
  peak: bigint;
  /** Whether the +100% half-bank has already happened. */
  banked: boolean;
  /** Tokens held when the last bank was issued; 0 when no bank is pending. */
  pendingBankTokens: bigint;
}

const tapes = new Map<Pubkey, CoinTape>();
const open = new Map<Pubkey, Open>();
/** Coins already bought once: never bought again. */
const done = new Set<Pubkey>();

function priceOf(quote: bigint, tokens: bigint): number {
  return Number(quote) / Number(tokens);
}

/** Liquidation value of `tokens` on a curve at its latest reserves, after curve fee and one tx fee. */
function valueOf(tokens: bigint, quote: bigint, reserve: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || reserve + tokens <= 0n) return 0n;
  const gross = (tokens * quote) / (reserve + tokens);
  return (gross * BigInt(10_000 - FEE_BPS)) / 10_000n - txFee;
}

/** Opening-tape verdict for a coin: distinct buyers, net flow, trade count. */
function tapeVerdict(tape: CoinTape, slot: number): { buyers: number; net: number; trades: number } {
  const from = slot - TAPE_SLOTS;
  let trades = 0;
  let net = 0;
  const buyers = new Set<Pubkey>();
  for (const t of tape.trades) {
    if (t.slot < from) continue;
    trades += 1;
    if (t.buy) {
      net += t.sol;
      if (t.user !== tape.creator) buyers.add(t.user);
    } else {
      net -= t.sol;
    }
  }
  return { buyers: buyers.size, net, trades };
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // ------------------------------------------------- fold the batch in
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapes.set(e.mint, {
          createdSlot: e.slot,
          createPrice: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          creator: e.creator,
          creatorSold: false,
          complete: false,
          trades: [],
        });
      } else if (e.event === 'TradeEvent') {
        let tape = tapes.get(e.mint);
        if (tape === undefined) {
          tape = {
            createdSlot: null,
            createPrice: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
            creator: e.creator,
            creatorSold: false,
            complete: false,
            trades: [],
          };
          tapes.set(e.mint, tape);
        }
        tape.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / Number(LAMPORTS_PER_SOL),
          user: e.user,
        });
        if (!e.is_buy && e.user === tape.creator) tape.creatorSold = true;
        const cutoff = slot - TAPE_SLOTS - 5;
        while (tape.trades.length > 0 && tape.trades[0]!.slot < cutoff) tape.trades.shift();
      } else {
        const tape = tapes.get(e.mint);
        if (tape !== undefined) tape.complete = true;
      }
    }

    // ------------------------------------------------- sync open positions
    for (const mint of [...open.keys()]) {
      if (!state.positions.has(mint)) open.delete(mint);
    }
    for (const [mint, pos] of state.positions) {
      let info = open.get(mint);
      if (info === undefined) {
        info = { buySlot: slot, basis: pos.cost_lamports, peak: 0n, banked: false, pendingBankTokens: 0n };
        open.set(mint, info);
      }
      // A banked half-sale filled: the token count dropped. Halve the
      // remaining cost basis and reset the peak to the value now held.
      if (info.pendingBankTokens > 0n && pos.token_amount < info.pendingBankTokens) {
        info.basis = (info.basis * pos.token_amount) / info.pendingBankTokens;
        const curve = state.curves.get(mint);
        info.peak = curve === undefined
          ? 0n
          : valueOf(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
        info.pendingBankTokens = 0n;
      }
    }

    const hasPendingSell = (mint: Pubkey): boolean =>
      [...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'sell');

    // ------------------------------------------------- exits first
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const info = open.get(mint);
      if (info === undefined || hasPendingSell(mint)) continue;
      const value = valueOf(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
      if (value > info.peak) info.peak = value;
      const basis = info.basis;
      const age = slot - info.buySlot;
      const stopBps = Math.round(STOP_LOSS * 10_000);
      const trailBps = Math.round(RUNNER_TRAIL * 10_000);
      const bankBps = Math.round(BANK_AT * 10_000);
      if (value <= (basis * BigInt(10_000 - stopBps)) / 10_000n) {
        // Stop loss: -25% of remaining cost, sell everything.
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      } else if (!info.banked && value >= (basis * BigInt(10_000 + bankBps)) / 10_000n) {
        // First double: bank half the tokens, let the rest ride — but only
        // when the half being sold is worth well more than its tx fee.
        const half = pos.token_amount / 2n;
        const halfValue = valueOf(half, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
        if (half > 0n && halfValue > MIN_BUY + txFee) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SLIPPAGE_BPS });
          info.banked = true;
          info.pendingBankTokens = pos.token_amount;
        }
      } else if (info.peak >= (basis * 2n) && value <= (info.peak * BigInt(10_000 - trailBps)) / 10_000n) {
        // Proven runner fell 30% off its peak: take what is left.
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      } else if (age >= MAX_HOLD) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      }
    }
    if (orders.length >= maxOrders) return orders;

    // ------------------------------------------------- entries
    // Equity = free cash + open positions at liquidation value. Each new
    // stake is a fifth of it, so winners compound and losers shrink the bet.
    let equity = state.freeCashLamports();
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      equity += valueOf(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
    }
    const stake = (equity * BigInt(STAKE_SHARE_NUM)) / BigInt(STAKE_SHARE_DEN);
    let free = state.freeCashLamports();
    let room = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= maxOrders || room <= 0) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (tape.createdSlot === null) continue;
      if (state.positions.has(mint) || done.has(mint)) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'buy')) continue;
      const age = slot - tape.createdSlot;
      if (age < 0 || age > ENTRY_MAX_AGE) continue;
      if (tape.creatorSold) continue;
      const verdict = tapeVerdict(tape, slot);
      if (verdict.trades < TAPE_MIN_TRADES) continue;
      if (verdict.buyers < TAPE_MIN_BUYERS) continue;
      if (verdict.net < TAPE_MIN_NET_SOL) continue;
      // Price still close to creation: never chase a runup.
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const runup = now / tape.createPrice - 1;
      if (runup < RUNUP_MIN || runup > RUNUP_MAX) continue;
      // Size: a fifth of equity, capped at 1% of the curve's real reserve.
      const cap = state.maxBuyLamports(mint);
      const amount = cap < stake ? cap : stake;
      if (amount < MIN_BUY) continue;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      done.add(mint);
      free -= amount + txFee;
      room -= 1;
    }
    return orders;
  },
});
