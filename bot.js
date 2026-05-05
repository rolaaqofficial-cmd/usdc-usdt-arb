const { ethers } = require("ethers");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT  = 5;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const LOAN_SIZES = [
  ethers.parseUnits("50000", 6),
  ethers.parseUnits("30000", 6),
  ethers.parseUnits("20000", 6),
  ethers.parseUnits("10000", 6),
  ethers.parseUnits("5000",  6),
];

// ─── Uniswap V3 ───────────────────────────────────────────────────────────────
const UNIV3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

// ─── QuickSwap V2 ─────────────────────────────────────────────────────────────
const QUICK_FACTORY = "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32";

// ─── SushiSwap V2 (Polygon) ───────────────────────────────────────────────────
const SUSHI_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

const FACTORY_ABI = ["function getPair(address,address) external view returns (address)"];
const PAIR_ABI = [
  "function getReserves() external view returns (uint112,uint112,uint32)",
  "function token0() external view returns (address)"
];

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const CONTRACT_ABI = ["function startArbitrage(uint256 amount, uint8 direction) external"];

let totalTrades  = 0;
let totalProfit  = 0;
let botStatus    = "Starting...";
let logs         = [];
let scanCount    = 0;
const botStarted = new Date().toISOString();

// ─── Pair cache (15 second TTL to avoid stale reserves) ───────────────────────
const pairCache = {};
const RESERVE_TTL_MS = 15000;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 200) logs.pop();
}

// ─── Uniswap V3 quote ─────────────────────────────────────────────────────────
async function uniQuote(tokenIn, tokenOut, fee, amountIn) {
  try {
    const q = new ethers.Contract(UNIV3_QUOTER, QUOTER_ABI, provider);
    const out = await q.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0);
    return BigInt(out);
  } catch(e) { return null; }
}

// ─── AMM V2 amount out formula ────────────────────────────────────────────────
function v2AmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = BigInt(amountIn) * 997n;
  const numerator       = amountInWithFee * BigInt(reserveOut);
  const denominator     = BigInt(reserveIn) * 1000n + amountInWithFee;
  return numerator / denominator;
}

// ─── Get reserves with cache (FIX: was caching forever, now TTL-based) ────────
async function getReserves(factoryAddress, label) {
  const now = Date.now();
  const cached = pairCache[factoryAddress];

  if (cached && (now - cached.ts) < RESERVE_TTL_MS) {
    return cached.data;
  }

  try {
    let pairAddr = cached?.pairAddr;
    if (!pairAddr) {
      const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
      pairAddr = await factory.getPair(WETH, USDT);
      log(`${label} pair: ${pairAddr}`);
    }

    const pair   = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const isWethToken0 = token0.toLowerCase() === WETH.toLowerCase();

    const data = {
      reserveWeth: isWethToken0 ? r0 : r1,
      reserveUsdt: isWethToken0 ? r1 : r0,
    };

    pairCache[factoryAddress] = { ts: now, data, pairAddr };
    return data;
  } catch(e) {
    log(`${label} reserves error: ${e.message}`);
    return null;
  }
}

// ─── Check one loan size across ALL 5 directions ──────────────────────────────
//  Directions:
//   0 = UniV3 → QuickSwap
//   1 = QuickSwap → UniV3
//   2 = UniV3 → SushiSwap
//   3 = SushiSwap → UniV3
//   4 = QuickSwap → SushiSwap
//   5 = SushiSwap → QuickSwap
async function checkAllOpportunities(loanAmount) {
  try {
    const loanNum = Number(loanAmount) / 1e6;

    const [quickRes, sushiRes] = await Promise.all([
      getReserves(QUICK_FACTORY, "QuickSwap"),
      getReserves(SUSHI_FACTORY, "SushiSwap"),
    ]);

    const results = [];

    // ── UniV3 buy → sell on V2 DEXes ──────────────────────────────────────────
    const wethFromUni = await uniQuote(USDT, WETH, 500, loanAmount);

    if (wethFromUni && quickRes) {
      const usdtBack = v2AmountOut(wethFromUni, quickRes.reserveWeth, quickRes.reserveUsdt);
      results.push({ dir: 0, label: "UniV3→Quick",  profit: (Number(usdtBack) / 1e6) - loanNum });
    }
    if (wethFromUni && sushiRes) {
      const usdtBack = v2AmountOut(wethFromUni, sushiRes.reserveWeth, sushiRes.reserveUsdt);
      results.push({ dir: 2, label: "UniV3→Sushi",  profit: (Number(usdtBack) / 1e6) - loanNum });
    }

    // ── V2 DEX buy → sell on UniV3 ────────────────────────────────────────────
    if (quickRes) {
      const wethFromQuick  = v2AmountOut(loanAmount, quickRes.reserveUsdt, quickRes.reserveWeth);
      const usdtBackUni    = await uniQuote(WETH, USDT, 500, wethFromQuick);
      if (usdtBackUni)
        results.push({ dir: 1, label: "Quick→UniV3", profit: (Number(usdtBackUni) / 1e6) - loanNum });
    }
    if (sushiRes) {
      const wethFromSushi  = v2AmountOut(loanAmount, sushiRes.reserveUsdt, sushiRes.reserveWeth);
      const usdtBackUni    = await uniQuote(WETH, USDT, 500, wethFromSushi);
      if (usdtBackUni)
        results.push({ dir: 3, label: "Sushi→UniV3", profit: (Number(usdtBackUni) / 1e6) - loanNum });
    }

    // ── QuickSwap ↔ SushiSwap ─────────────────────────────────────────────────
    if (quickRes && sushiRes) {
      const wethFromQuick = v2AmountOut(loanAmount, quickRes.reserveUsdt, quickRes.reserveWeth);
      const usdtBackSushi = v2AmountOut(wethFromQuick, sushiRes.reserveWeth, sushiRes.reserveUsdt);
      results.push({ dir: 4, label: "Quick→Sushi",  profit: (Number(usdtBackSushi) / 1e6) - loanNum });

      const wethFromSushi = v2AmountOut(loanAmount, sushiRes.reserveUsdt, sushiRes.reserveWeth);
      const usdtBackQuick = v2AmountOut(wethFromSushi, quickRes.reserveWeth, quickRes.reserveUsdt);
      results.push({ dir: 5, label: "Sushi→Quick",  profit: (Number(usdtBackQuick) / 1e6) - loanNum });
    }

    if (!results.length) return null;

    // Best direction
    const best = results.reduce((a, b) => a.profit > b.profit ? a : b);

    return {
      ...best,
      profitable: best.profit >= MIN_PROFIT,
      loanNum,
      loan: loanAmount,
      allResults: results,
    };

  } catch(e) {
    log("Opportunity error: " + e.message);
    return null;
  }
}

// ─── FIX: Try ALL loan sizes, pick best profitable one ───────────────────────
async function findBestOpportunity() {
  const opps = await Promise.all(LOAN_SIZES.map(loan => checkAllOpportunities(loan)));
  const valid = opps.filter(Boolean);
  if (!valid.length) return null;

  // First check if any are profitable
  const profitable = valid.filter(o => o.profitable);
  if (profitable.length) {
    return profitable.reduce((a, b) => a.profit > b.profit ? a : b);
  }

  // Otherwise return best (for logging)
  return valid.reduce((a, b) => a.profit > b.profit ? a : b);
}

async function executeTrade(loan, direction) {
  try {
    log(`🚀 Executing $${(Number(loan)/1e6).toFixed(0)} dir:${direction}...`);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    const fee = await provider.getFeeData();

    const tx = await contract.startArbitrage(loan, direction, {
      gasLimit: 900000,
      maxFeePerGas:         fee.maxFeePerGas * 2n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 3n,
    });

    log("📤 TX: " + tx.hash);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      log("✅ SUCCESS! " + tx.hash);
      return true;
    } else {
      log("❌ Reverted");
      return false;
    }
  } catch(e) {
    log("❌ Error: " + e.message);
    return false;
  }
}

async function scan() {
  try {
    scanCount++;
    const opp = await findBestOpportunity();
    if (!opp) return;

    if (scanCount % 3 === 0) {
      const allStr = opp.allResults.map(r => `${r.label}:$${r.profit.toFixed(2)}`).join(" | ");
      log(`#${scanCount} | $${opp.loanNum.toFixed(0)} | Best:[${opp.label} $${opp.profit.toFixed(4)}] | ${allStr}`);
    }

    if (opp.profitable) {
      log(`💰 PROFIT $${opp.profit.toFixed(2)}! Loan:$${opp.loanNum} Dir:${opp.label}`);
      botStatus = `🚀 EXECUTING! ${opp.label} | $${opp.profit.toFixed(2)}`;

      const ok = await executeTrade(opp.loan, opp.dir);
      if (ok) {
        totalTrades++;
        totalProfit += opp.profit;
        botStatus = `✅ Trade #${totalTrades} | $${opp.profit.toFixed(2)} | Total:$${totalProfit.toFixed(2)}`;
        log(`🏆 Total:$${totalProfit.toFixed(2)} | Trades:${totalTrades}`);
      } else {
        botStatus = `❌ Failed — scanning...`;
      }
    } else {
      botStatus = `⏸ Best: ${opp.label} $${opp.profit.toFixed(2)} | Need $${MIN_PROFIT}`;
    }

  } catch(e) {
    log("Scan error: " + e.message);
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const up = Math.floor((Date.now() - new Date(botStarted).getTime()) / 1000);
  const h  = Math.floor(up / 3600);
  const m  = Math.floor((up % 3600) / 60);
  const s  = up % 60;

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARB BOT</title>
<meta http-equiv="refresh" content="2">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#030303;color:#00ff88;font-family:'Courier New',monospace;padding:16px}
h1{text-align:center;font-size:20px;margin-bottom:14px;letter-spacing:3px}
.status{background:#0a0a0a;border:1px solid #00ff8866;border-radius:10px;padding:14px;margin-bottom:14px;text-align:center;font-size:13px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.card{background:#0a0a0a;border:1px solid #00ff8822;border-radius:10px;padding:12px}
.label{color:#444;font-size:9px;letter-spacing:1px;margin-bottom:6px}
.value{font-size:20px;font-weight:bold;color:#00ff88}
.logs{background:#0a0a0a;border:1px solid #00ff8822;border-radius:10px;padding:12px;max-height:350px;overflow-y:auto}
.log-line{font-size:10px;color:#555;padding:3px 0;border-bottom:1px solid #111}
.badge{display:inline-block;background:#00ff8811;border:1px solid #00ff8833;border-radius:4px;padding:2px 6px;font-size:9px;margin:2px}
</style>
</head>
<body>
<h1>⚡ WETH/USDT ARB BOT v2</h1>
<div class="status">${botStatus}</div>
<div style="text-align:center;margin-bottom:10px">
  <span class="badge">UniswapV3</span>
  <span class="badge">QuickSwap</span>
  <span class="badge">SushiSwap</span>
  <span class="badge">6 Directions</span>
</div>
<div class="grid">
  <div class="card"><div class="label">TOTAL PROFIT</div><div class="value">$${totalProfit.toFixed(2)}</div></div>
  <div class="card"><div class="label">TOTAL TRADES</div><div class="value">${totalTrades}</div></div>
  <div class="card"><div class="label">MIN PROFIT</div><div class="value">$${MIN_PROFIT}</div></div>
  <div class="card"><div class="label">MEV PROTECTION</div><div class="value" style="font-size:12px">3x Gas ⚡</div></div>
  <div class="card"><div class="label">SCANS</div><div class="value">${scanCount}</div></div>
  <div class="card"><div class="label">UPTIME</div><div class="value" style="font-size:14px">${h}h ${m}m ${s}s</div></div>
</div>
<div class="logs">
${logs.map(l => `<div class="log-line">${l}</div>`).join("")}
</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  log("⚡ WETH/USDT ARB BOT v2 started!");
  log("📍 Polygon Mainnet");
  log("💰 Smart loan: $5k-$50k auto");
  log("🎯 Min profit: $" + MIN_PROFIT);
  log("⚡ MEV: 3x Priority Gas");
  log("🔄 6 directions: UniV3↔Quick↔Sushi");
  log("🔧 Reserve cache: 15s TTL (fresh data)");
  log("📝 Contract: " + CONTRACT_ADDRESS);
  log("💼 Wallet: " + wallet.address);
});

setInterval(scan, 3000);
scan();
