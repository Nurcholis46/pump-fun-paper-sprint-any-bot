// Fresh-launch momentum sniper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die within minutes of launch, but the ones that survive
// the first few slots with genuine outside buying often run 10-30% before the
// early buyers take profit. This bot only buys launches that look alive, sizes
// every bet the same small amount, and gets out fast either way.
//
// Entry (first buy only, no averaging down):
//   - the coin is 0-4 slots old at decision time (fresh, but the create slot's
//     tape is already visible);
//   - real SOL in the curve is between 0.3 and 30 SOL (too thin = no liquidity
//     to exit into, too fat = already ran);
//   - the creator's own buy in the create slot is at most 2.5 SOL (skin in the
//     game is fine, a giant dev pre-buy is a dump setup);
//   - 1-3 distinct non-creator buyers have already bought (zero buyers = nobody
//     cares; a crowd of wallets in the first slots = a bundled launch);
//   - the creator has not sold, and no single non-creator sell is bigger than
//     3% of the real SOL reserve (a whale already exiting);
//   - price is at most 15% above the create price (do not chase a coin that
//     already ran);
//   - net SOL flow over the last 10 slots is not negative.
//
// Exits (checked every batch, exits first so a sell never waits behind a buy):
//   - partial take-profit: sell half at +6% over all-in cost;
//   - full take-profit at +8%, stop-loss at -5% (after the partial, the rest
//     stops at cost, so a winner can never turn into a loser);
//   - trailing stop: once a position is +6%, exit on a 5% pullback from its best
//     mark-to-market value;
//   - hard time stop: 60 slots max hold (about 24 seconds of chain time);
//   - the creator sells while we hold -> exit immediately;
//   - no trade on the coin for 120 slots -> exit (dead coin, free the slot).
//
// Risk / guardrails:
//   - 0.05 SOL per coin, never more than the harness cap of 1% of real reserves;
//   - at most 5 open positions (the harness cap);
//   - every round trip is >= 0.01 SOL, and the bot trades dozens of coins, so
//     the 20-distinct-mints bar is cleared with room to spare;
//   - worst case per coin is the -5% stop plus fees on 0.05 SOL, so even a run
//     of losers cannot approach the 50% max-drawdown guardrail.
//
// Deterministic by construction: a pure function of the batches it is fed.
// No clock, no randomness, no I/O, no network.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** Lamports put into one coin. */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buys in the create slot: at most this many lamports. */
  maxDevBuyLamports: number;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Largest single non-creator sell, as bps of the real SOL reserve before it. */
  maxSingleSellBps: number;
  /** Price now over the create price, as bps (10000 = flat): at most this. */
  maxRunupBps: number;
  /** Recent-flow window (slots) and the net SOL it must show (lamports, may be negative). */
  flowWindowSlots: number;
  minFlowLamports: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Partial take-profit: sell this share (bps) once value is tp1Bps over cost. */
  tp1Bps: number;
  tp1ShareBps: number;
  /** After the partial take-profit, the rest stops out at this bps under cost. */
  stopAfterTp1Bps: number;
  /** Full exit when value is this far over cost (bps). */
  tpBps: number;
  /** Full exit when value is this far under cost (bps). */
  slBps: number;
  /** Trailing stop: arms once value is trailArmBps over cost, exits on a trailBps fall from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 4,
  stakeLamports: 50_000_000,
  minBuyLamports: 10_000_000,
  minRealSolLamports: 300_000_000,
  maxRealSolLamports: 30_000_000_000,
  maxDevBuyLamports: 2_500_000_000,
  minBuyers: 1,
  maxBuyers: 3,
  maxSingleSellBps: 300,
  maxRunupBps: 11_500,
  flowWindowSlots: 10,
  minFlowLamports: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 600,
  tp1ShareBps: 5_000,
  stopAfterTp1Bps: 0,
  tpBps: 800,
  slBps: 500,
  trailArmBps: 600,
  trailBps: 500,
  maxHoldSlots: 60,
  exitOnDevSell: true,
  staleSlots: 120,
};

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  /** Largest single non-creator sell, as bps of the reserve before it. */
  biggestSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindowSlots slots (older ones dropped as new ones come). */
  recent: TapeTick[];
  boughtOnce: boolean;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  bestValue: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees (protocol 95 + creator 30 bps) charged on a sell. */
const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          buyers: new Set(),
          bought: 0n,
          biggestSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.biggestSellBps) c.biggestSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold over the last flowWindowSlots slots. */
  function recentFlow(c: Coin, slot: number): bigint {
    const from = slot - P.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Track fills: a filled buy opens a Held record, a harness close clears it.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            bestValue: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // --- Exits first. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, bestValue: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.bestValue) h.bestValue = value;
        let exit = false;
        if (basis > 0n) {
          // Partial take-profit: bank half at +tp1Bps, then the rest can only
          // stop out at cost (never a winner turning into a loser).
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1ShareBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.bestValue = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          const sl = h.tookTp1 ? BigInt(P.stopAfterTp1Bps) : BigInt(P.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
          if (
            h.bestValue * BPS >= basis * (BPS + BigInt(P.trailArmBps)) &&
            value * BPS <= h.bestValue * (BPS - BigInt(P.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= P.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Entries. ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.boughtOnce) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAgeSlots) {
          c.done = true;
          continue;
        }
        if (age < P.minAgeSlots) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Quality filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSolLamports) || rq > BigInt(P.maxRealSolLamports)) continue;
        if (c.devBuy > BigInt(P.maxDevBuyLamports)) continue;
        if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.biggestSellBps > BigInt(P.maxSingleSellBps)) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup > BigInt(P.maxRunupBps)) continue;
        if (recentFlow(c, state.slot) < BigInt(P.minFlowLamports)) continue;
        // Size: fixed stake, capped by the harness's 1%-of-real-reserve rule.
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.boughtOnce = true;
        open += 1;
      }
      return orders;
    },
  };
}
