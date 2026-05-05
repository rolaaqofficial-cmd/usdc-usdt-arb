const { ethers } = require("ethers");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const RPC_URL          = process.env.RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const MIN_PROFIT       = parseFloat(process.env.MIN_PROFIT || "5");
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

// ── DEX Pools (Polygon) ─────────────────────────────────
const POOLS = {
  "Curve_Aave":    { address: "0x445FE580eF8d70FF569aB36e80c647af338db351", type: "curve" },
  "Curve_3Pool":   { address: "0x19793B454D3AfC7b454F206Ffe95aDE26cA6912c", type: "curve" },
};

// QuickSwap + SushiSwap routers
const ROUTERS = {
  "QuickSwap":  "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  "SushiSwap":  "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
};

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const CURVE_ABI = [
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)",
];

const CONTRACT_ABI = [
  "function startArbitrage(uint256 amount) external",
];

let totalTrades  = 0;
let totalProfit  = 0;
let bestGap      = "0";
let botStatus    = "Starting...";
let logs         = [];
let opportunities = [];
const botStarted = new Date().toISOString();

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 100) logs.pop();
}

// ── Get Curve Price ──────────────────────────────────────
async function getCurvePrice(poolAddr, amountIn) {
  try {
    const curve = new ethers.Contract(poolAddr, CURVE_ABI, provider);
    const out = await curve.get_dy_underlying(1, 2, amountIn);
    return Number(out);
  } catch(e) { return 0; }
}

// ── Get Router Price ─────────────────────────────────────
async function getRouterPrice(routerAddr, amountIn) {
  try {
    const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
    const amounts = await router.getAmountsOut(amountIn, [USDC, USDT]);
    return Number(amounts[1]);
  } catch(e) { return 0; }
}

// ── Scan All DEX ─────────────────────────────────────────
async function scanAllDEX(loanAmount) {
  const results = [];

  // Curve prices
  for(const [name, pool] of Object.entries(POOLS)) {
    const out = await getCurvePrice(pool.address, loanAmount);
    if(out > 0) results.push({ name, out, fee: 0.0001 });
  }

  // Router prices
  for(const [name, addr] of Object.entries(ROUTERS)) {
    const out = await getRouterPrice(addr, loanAmount);
    if(out > 0) results.push({ name, out, fee: 0.003 });
  }

  return results;
}

// ── Calculate Best Opportunity ───────────────────────────
function findBestOpportunity(results, loanAmount) {
  const loan = Number(loanAmount) / 1e6;
  let best = null;

  for(const buy of results) {
    for(const sell of results) {
      if(buy.name === sell.name) continue;

      const buyOut  = buy.out / 1e6;
      const sellOut = sell.out / 1e6;

      if(buyOut <= 0 || sellOut <= 0) continue;

      const gross   = sellOut - loan;
      const aaveFee = loan * 0.0009;
      const buyFee  = loan * buy.fee;
      const sellFee = loan * sell.fee;
      const gasFee  = 0.05;
      const net     = gross - aaveFee - buyFee - sellFee - gasFee;

      if(!best || net > best.net) {
        best = {
          buyDex:  buy.name,
          sellDex: sell.name,
          gross:   gross.toFixed(4),
          net:     net.toFixed(4),
          profitable: net >= MIN_PROFIT,
        };
      }
    }
  }
  return best;
}

async function executeTrade(loanAmount) {
  try {
    log("🚀 Executing trade...");
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    const tx = await contract.startArbitrage(loanAmount, { gasLimit: 600000 });
    log("TX: " + tx.hash);
    const receipt = await tx.wait();
    if(receipt.status === 1) {
      log("✅ Trade SUCCESS!");
      return true;
    }
    log("❌ Trade failed");
    return false;
  } catch(e) {
    log("Trade error: " + e.message);
    return false;
  }
}

async function scan() {
  try {
    const loanAmount = ethers.parseUnits("50000", 6);
    const results = await scanAllDEX(loanAmount);
    
    if(results.length === 0) {
      log("No prices fetched");
      return;
    }

    const best = findBestOpportunity(results, loanAmount);
    
    if(!best) return;

    bestGap = best.gross;
    
    // Log all prices
    const priceStr = results.map(r => `${r.name}:$${(r.out/1e6).toFixed(2)}`).join(" | ");
    log(`Prices: ${priceStr}`);
    log(`Best: ${best.buyDex}→${best.sellDex} | Gross:$${best.gross} | Net:$${best.net}`);

    if(best.profitable) {
      botStatus = `🚀 EXECUTING! ${best.buyDex}→${best.sellDex} Net:$${best.net}`;
      const ok = await executeTrade(loanAmount);
      if(ok) {
        totalTrades++;
        totalProfit += parseFloat(best.net);
        botStatus = `✅ Profit: $${best.net}`;
      }
    } else {
      botStatus = `Waiting | Best Gap: $${best.gross} | Need: $${MIN_PROFIT}`;
    }
  } catch(e) {
    log("Error: " + e.message);
  }
}

app.get("/", (req, res) => {
  const up = Math.floor((Date.now() - new Date(botStarted).getTime()) / 1000);
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Multi DEX ARB BOT</title>
<meta http-equiv="refresh" content="2">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050505;color:#00ff88;font-family:monospace;padding:16px}
h1{text-align:center;font-size:18px;margin-bottom:12px}
.s{background:#111;border:1px solid #00ff8844;border-radius:8px;padding:12px;margin-bottom:12px;text-align:center;font-size:13px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.c{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px}
.c h3{color:#555;font-size:10px;margin-bottom:4px}
.c .v{font-size:16px;font-weight:bold}
.l{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px;max-height:300px;overflow-y:auto}
.li{font-size:11px;color:#777;padding:2px 0;border-bottom:1px solid #1a1a1a}
</style>
</head>
<body>
<h1>🤖 MULTI DEX ARB BOT</h1>
<div class="s">${botStatus}</div>
<div class="g">
<div class="c"><h3>TOTAL PROFIT</h3><div class="v">$${totalProfit.toFixed(2)}</div></div>
<div class="c"><h3>TOTAL TRADES</h3><div class="v">${totalTrades}</div></div>
<div class="c"><h3>LOAN</h3><div class="v">$50,000</div></div>
<div class="c"><h3>BEST GAP</h3><div class="v">$${bestGap}</div></div>
<div class="c"><h3>MIN PROFIT</h3><div class="v">$${MIN_PROFIT}</div></div>
<div class="c"><h3>DEX COUNT</h3><div class="v">4</div></div>
<div class="c"><h3>UPTIME</h3><div class="v">${Math.floor(up/3600)}h${Math.floor((up%3600)/60)}m</div></div>
<div class="c"><h3>NETWORK</h3><div class="v" style="font-size:12px">Polygon</div></div>
</div>
<div class="l">${logs.map(l=>`<div class="li">${l}</div>`).join("")}</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  log("🚀 Multi DEX Bot started!");
  log("Monitoring: Curve Aave + Curve 3Pool + QuickSwap + SushiSwap");
  log("Wallet: " + wallet.address);
  log("Min profit: $" + MIN_PROFIT);
});

setInterval(scan, 2000);
scan();
