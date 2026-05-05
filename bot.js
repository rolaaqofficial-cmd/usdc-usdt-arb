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

// Curve Pools Polygon
const CURVE_AAVE  = "0x445FE580eF8d70FF569aB36e80c647af338db351";
const CURVE_3POOL = "0x19793B454D3AfC7b454F206Ffe95aDE26cA6912c";

const CURVE_ABI = [
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
];

const CONTRACT_ABI = [
  "function startArbitrage(uint256 amount) external",
];

let totalTrades = 0;
let totalProfit = 0;
let botStatus   = "Starting...";
let logs        = [];
const botStarted = new Date().toISOString();

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 100) logs.pop();
}

async function getPrice(poolAddr, i, j, amountIn, useUnderlying) {
  try {
    const curve = new ethers.Contract(poolAddr, CURVE_ABI, provider);
    if(useUnderlying) {
      return Number(await curve.get_dy_underlying(i, j, amountIn));
    } else {
      return Number(await curve.get_dy(i, j, amountIn));
    }
  } catch(e) { return 0; }
}

async function scan() {
  try {
    const loanAmount = ethers.parseUnits("50000", 6);

    // Curve Aave: USDC(1) → USDT(2)
    const aave_out = await getPrice(CURVE_AAVE, 1, 2, loanAmount, true);
    // Curve 3Pool: USDC(1) → USDT(2)  
    const pool3_out = await getPrice(CURVE_3POOL, 1, 2, loanAmount, true);

    if(aave_out === 0 && pool3_out === 0) {
      log("No prices available");
      return;
    }

    const loan = 50000;
    const aavePrice  = aave_out  / 1e6;
    const pool3Price = pool3_out / 1e6;

    log(`Curve Aave: $${aavePrice.toFixed(4)} | Curve 3Pool: $${pool3Price.toFixed(4)}`);

    // Check A→B direction
    let gross = 0;
    let direction = "";

    if(aave_out > pool3_out && aave_out > 0) {
      // Buy on 3Pool, sell on Aave
      const returned = aavePrice;
      gross = returned - loan;
      direction = "3Pool→Aave";
    } else if(pool3_out > aave_out && pool3_out > 0) {
      // Buy on Aave, sell on 3Pool
      const returned = pool3Price;
      gross = returned - loan;
      direction = "Aave→3Pool";
    }

    const fees = (loan * 0.0009) + (loan * 0.0001) + (loan * 0.0001) + 0.05;
    const net  = gross - fees;

    log(`Direction: ${direction} | Gross: $${gross.toFixed(4)} | Net: $${net.toFixed(4)}`);

    if(net >= MIN_PROFIT) {
      botStatus = `🚀 EXECUTING! ${direction} Net:$${net.toFixed(2)}`;
      log("✅ PROFITABLE! Executing...");

      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
      const tx = await contract.startArbitrage(loanAmount, { gasLimit: 600000 });
      log("TX: " + tx.hash);
      const receipt = await tx.wait();

      if(receipt.status === 1) {
        totalTrades++;
        totalProfit += net;
        botStatus = `✅ Trade done! Profit: $${net.toFixed(2)}`;
        log(`✅ SUCCESS! Total: $${totalProfit.toFixed(2)}`);
      }
    } else {
      botStatus = `Waiting | ${direction} | Gap: $${gross.toFixed(4)} | Need: $${MIN_PROFIT}`;
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
<title>Curve ARB BOT</title>
<meta http-equiv="refresh" content="2">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050505;color:#00ff88;font-family:monospace;padding:16px}
h1{text-align:center;font-size:18px;margin-bottom:12px}
.s{background:#111;border:1px solid #00ff8844;border-radius:8px;padding:12px;margin-bottom:12px;text-align:center;font-size:13px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.c{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px}
.c h3{color:#555;font-size:10px;margin-bottom:4px}
.c .v{font-size:18px;font-weight:bold}
.l{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px;max-height:300px;overflow-y:auto}
.li{font-size:11px;color:#777;padding:2px 0;border-bottom:1px solid #1a1a1a}
</style>
</head>
<body>
<h1>🤖 CURVE ARB BOT</h1>
<div class="s">${botStatus}</div>
<div class="g">
<div class="c"><h3>TOTAL PROFIT</h3><div class="v">$${totalProfit.toFixed(2)}</div></div>
<div class="c"><h3>TOTAL TRADES</h3><div class="v">${totalTrades}</div></div>
<div class="c"><h3>LOAN</h3><div class="v">$50,000</div></div>
<div class="c"><h3>MIN PROFIT</h3><div class="v">$${MIN_PROFIT}</div></div>
<div class="c"><h3>UPTIME</h3><div class="v">${Math.floor(up/3600)}h${Math.floor((up%3600)/60)}m</div></div>
<div class="c"><h3>POOLS</h3><div class="v" style="font-size:12px">Curve x2</div></div>
</div>
<div class="l">${logs.map(l=>`<div class="li">${l}</div>`).join("")}</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  log("🚀 Curve ARB Bot started!");
  log("Pools: Curve Aave + Curve 3Pool");
  log("Wallet: " + wallet.address);
  log("Min profit: $" + MIN_PROFIT);
});

setInterval(scan, 2000);
scan();
