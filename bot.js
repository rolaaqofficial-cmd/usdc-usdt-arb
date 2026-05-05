const { ethers } = require("ethers");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT  = parseFloat(process.env.MIN_PROFIT || "5");
const LOAN        = ethers.parseUnits("20000", 6);

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

const DEXES = [
  { name: "Uniswap V3 0.05%", quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6", fee: 500 },
  { name: "Uniswap V3 0.3%",  quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6", fee: 3000 },
  { name: "QuickSwap V3",     quoter: "0xa15F0D7377B2A0C0c10db057f641beD21028FC89", fee: 500 },
];

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const CONTRACT_ABI = [
  "function startArbitrage(uint256 amount, bool buyOnUniswap) external"
];

let totalTrades = 0;
let totalProfit = 0;
let botStatus   = "Starting...";
let logs        = [];
let scanCount   = 0;
const botStarted = new Date().toISOString();

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 150) logs.pop();
}

async function getQuote(quoter, tokenIn, tokenOut, fee, amountIn) {
  try {
    const q = new ethers.Contract(quoter, QUOTER_ABI, provider);
    const out = await q.quoteExactInputSingle.staticCall(
      tokenIn, tokenOut, fee, amountIn, 0
    );
    return BigInt(out);
  } catch(e) {
    return null;
  }
}

async function checkOpportunity() {
  try {
    let bestProfit = -999;
    let bestOpp = null;

    for (let i = 0; i < DEXES.length; i++) {
      for (let j = 0; j < DEXES.length; j++) {
        if (i === j) continue;

        const buyDex  = DEXES[i];
        const sellDex = DEXES[j];

        const wethOut = await getQuote(
          buyDex.quoter, USDT, WETH, buyDex.fee, LOAN
        );
        if (!wethOut) continue;

        const usdtBack = await getQuote(
          sellDex.quoter, WETH, USDT, sellDex.fee, wethOut
        );
        if (!usdtBack) continue;

        const loanNum  = Number(LOAN) / 1e6;
        const backNum  = Number(usdtBack) / 1e6;
        const profit   = backNum - loanNum;

        if (profit > bestProfit) {
          bestProfit = profit;
          bestOpp = {
            buyDex:  buyDex.name,
            sellDex: sellDex.name,
            profit:  profit,
            profitable: profit >= MIN_PROFIT,
            buyOnUniswap: i === 0 || i === 1,
          };
        }
      }
    }

    return bestOpp;

  } catch(e) {
    log("Check error: " + e.message);
    return null;
  }
}

async function executeTrade(buyOnUniswap) {
  try {
    log("🚀 Executing...");
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

    // High priority gas — MEV se aage rahenge!
    const fee = await provider.getFeeData();
    const priorityFee = fee.maxPriorityFeePerGas * 3n;
    const maxFee = fee.maxFeePerGas * 2n;

    const tx = await contract.startArbitrage(LOAN, buyOnUniswap, {
      gasLimit: 800000,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
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
    const opp = await checkOpportunity();
    if (!opp) return;

    if (scanCount % 3 === 0) {
      log(`#${scanCount} | Buy:${opp.buyDex} Sell:${opp.sellDex} | $${opp.profit.toFixed(4)}`);
    }

    if (opp.profitable) {
      log(`💰 PROFIT $${opp.profit.toFixed(4)}! Executing...`);
      botStatus = `🚀 EXECUTING! $${opp.profit.toFixed(2)}`;

      const ok = await executeTrade(opp.buyOnUniswap);
      if (ok) {
        totalTrades++;
        totalProfit += opp.profit;
        botStatus = `✅ Trade #${totalTrades} | $${opp.profit.toFixed(2)} | Total: $${totalProfit.toFixed(2)}`;
      } else {
        botStatus = `❌ Failed — scanning...`;
      }
    } else {
      botStatus = `⏸ Best: ${opp.buyDex}→${opp.sellDex} | $${opp.profit.toFixed(4)} | Need $${MIN_PROFIT}`;
    }

  } catch(e) {
    log("Scan error: " + e.message);
  }
}

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
.logs{background:#0a0a0a;border:1px solid #00ff8822;border-radius:10px;padding:12px;max-height:300px;overflow-y:auto}
.log-line{font-size:10px;color:#555;padding:3px 0;border-bottom:1px solid #111}
</style>
</head>
<body>
<h1>⚡ WETH/USDT ARB BOT</h1>
<div class="status">${botStatus}</div>
<div class="grid">
  <div class="card"><div class="label">TOTAL PROFIT</div><div class="value">$${totalProfit.toFixed(2)}</div></div>
  <div class="card"><div class="label">TOTAL TRADES</div><div class="value">${totalTrades}</div></div>
  <div class="card"><div class="label">LOAN</div><div class="value">$20,000</div></div>
  <div class="card"><div class="label">MIN PROFIT</div><div class="value">$${MIN_PROFIT}</div></div>
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
  log("⚡ WETH/USDT ARB BOT started!");
  log("📍 Polygon Mainnet");
  log("💰 Loan: $20,000 USDT");
  log("🎯 Min profit: $" + MIN_PROFIT);
  log("⚡ MEV Protection: High Priority Gas 3x");
  log("📝 Contract: " + CONTRACT_ADDRESS);
  log("💼 Wallet: " + wallet.address);
});

setInterval(scan, 1000);
scan();
