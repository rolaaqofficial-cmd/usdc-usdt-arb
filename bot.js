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

// Loan sizes to try — bot khud best dhundega
const LOAN_SIZES = [
  ethers.parseUnits("50000", 6),
  ethers.parseUnits("30000", 6),
  ethers.parseUnits("20000", 6),
  ethers.parseUnits("10000", 6),
  ethers.parseUnits("5000",  6),
];

const UNIV3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

const QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)"
];

// Uniswap V3 Router
const ROUTER_UNI = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const ROUTER_ABI = [
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external returns (uint256)"
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

async function getQuote(tokenIn, tokenOut, fee, amountIn) {
  try {
    const q = new ethers.Contract(UNIV3_QUOTER, QUOTER_ABI, provider);
    const out = await q.quoteExactInputSingle.staticCall(
      tokenIn, tokenOut, fee, amountIn, 0
    );
    return BigInt(out);
  } catch(e) {
    return null;
  }
}

async function checkOpportunity(loanAmount) {
  try {
    const loanNum = Number(loanAmount) / 1e6;

    // Buy WETH on Uniswap 0.05%, Sell on Uniswap 0.3%
    const wethOut1   = await getQuote(USDT, WETH, 500,  loanAmount);
    const usdtBack1  = wethOut1 ? await getQuote(WETH, USDT, 3000, wethOut1) : null;
    const profit1    = usdtBack1 ? (Number(usdtBack1) / 1e6) - loanNum : -9999;

    // Buy WETH on Uniswap 0.3%, Sell on Uniswap 0.05%
    const wethOut2   = await getQuote(USDT, WETH, 3000, loanAmount);
    const usdtBack2  = wethOut2 ? await getQuote(WETH, USDT, 500,  wethOut2) : null;
    const profit2    = usdtBack2 ? (Number(usdtBack2) / 1e6) - loanNum : -9999;

    const bestProfit = Math.max(profit1, profit2);
    const buyOnUni   = profit1 >= profit2;

    // Slippage check — agar profit margin kam hai skip karo
    const profitPct = (bestProfit / loanNum) * 100;
    if (profitPct < 0.025) return { profit: bestProfit, profitable: false, loanNum, profitPct };

    return {
      profit:      bestProfit,
      profitable:  bestProfit >= MIN_PROFIT,
      buyOnUni:    buyOnUni,
      loanNum:     loanNum,
      profitPct:   profitPct,
      direction:   buyOnUni ? "Uni 0.05% → Uni 0.3%" : "Uni 0.3% → Uni 0.05%"
    };

  } catch(e) {
    log("Check error: " + e.message);
    return null;
  }
}

async function findBestOpportunity() {
  let bestOpp = null;
  let bestProfit = -9999;

  for (const loan of LOAN_SIZES) {
    const opp = await checkOpportunity(loan);
    if (!opp) continue;

    if (opp.profit > bestProfit) {
      bestProfit = opp.profit;
      bestOpp = { ...opp, loan };
    }

    // Agar bada loan acha profit de raha hai to chhota try na karo
    if (opp.profitable && opp.profitPct > 0.05) break;
  }

  return bestOpp;
}

async function executeTrade(loan, buyOnUni) {
  try {
    log("🚀 Executing flash loan $" + (Number(loan)/1e6).toFixed(0) + "...");
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    const fee = await provider.getFeeData();

    // 3x priority fee — MEV bots se aage!
    const tx = await contract.startArbitrage(loan, buyOnUni, {
      gasLimit: 900000,
      maxFeePerGas: fee.maxFeePerGas * 2n,
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

    const loanStr = "$" + opp.loanNum.toFixed(0);

    if (scanCount % 3 === 0) {
      log(`#${scanCount} | ${opp.direction} | Loan:${loanStr} | $${opp.profit.toFixed(4)} | ${opp.profitPct?.toFixed(4)}%`);
    }

    if (opp.profitable) {
      log(`💰 PROFIT $${opp.profit.toFixed(2)} on ${loanStr} loan!`);
      botStatus = `🚀 EXECUTING! ${loanStr} | $${opp.profit.toFixed(2)}`;

      const ok = await executeTrade(opp.loan, opp.buyOnUni);
      if (ok) {
        totalTrades++;
        totalProfit += opp.profit;
        botStatus = `✅ Trade #${totalTrades} | $${opp.profit.toFixed(2)} | Total: $${totalProfit.toFixed(2)}`;
        log(`🏆 Total: $${totalProfit.toFixed(2)} | Trades: ${totalTrades}`);
      } else {
        botStatus = `❌ Failed — scanning...`;
      }
    } else {
      botStatus = `⏸ Best: ${opp.direction} | ${loanStr} | $${opp.profit.toFixed(4)} | Need $${MIN_PROFIT}`;
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
  log("⚡ WETH/USDT ARB BOT started!");
  log("📍 Polygon Mainnet");
  log("💰 Smart loan: $5k-$50k auto");
  log("🎯 Min profit: $" + MIN_PROFIT);
  log("⚡ MEV Protection: 3x Priority Gas");
  log("📝 Contract: " + CONTRACT_ADDRESS);
  log("💼 Wallet: " + wallet.address);
});

setInterval(scan, 1000);
scan();
