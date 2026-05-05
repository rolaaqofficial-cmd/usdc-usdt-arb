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

const CURVE_POOL = "0x445FE580eF8d70FF569aB36e80c647af338db351";
const USDC       = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT       = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

const CURVE_ABI = [
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
];

const CONTRACT_ABI = [
  "function startArbitrage(uint256 amount) external",
];

let totalTrades  = 0;
let totalProfit  = 0;
let currentGap   = "0";
let currentBack  = "0";
let botStatus    = "Starting...";
let logs         = [];
const botStarted = new Date().toISOString();

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 100) logs.pop();
}

async function checkPrices(loanAmount) {
  try {
    const curve = new ethers.Contract(CURVE_POOL, CURVE_ABI, provider);
    const forward  = await curve.get_dy_underlying(1, 2, loanAmount);
    const backward = await curve.get_dy_underlying(2, 1, forward);
    return { forward, backward };
  } catch(e) {
    log("Price error: " + e.message);
    return null;
  }
}

function calculateProfit(loanAmount, backward) {
  const loan     = Number(loanAmount) / 1e6;
  const returned = Number(backward)   / 1e6;
  const fees     = (loan * 0.0009) + (loan * 0.0001) + (loan * 0.0001) + 0.05;
  const gross    = returned - loan;
  const net      = gross - fees;
  return {
    loan:       loan.toFixed(2),
    returned:   returned.toFixed(4),
    gross:      gross.toFixed(4),
    fees:       fees.toFixed(4),
    net:        net.toFixed(4),
    profitable: net >= MIN_PROFIT,
  };
}

async function executeTrade(loanAmount) {
  try {
    log("Executing trade...");
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    const tx = await contract.startArbitrage(loanAmount, { gasLimit: 500000 });
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
    const loanAmount = ethers.parseUnits("10000", 6);
    const prices = await checkPrices(loanAmount);
    if (!prices) return;
    const p = calculateProfit(loanAmount, prices.backward);
    currentGap  = p.gross;
    currentBack = p.returned;
    log(`Scan | Loan:$${p.loan} Back:$${p.returned} Net:$${p.net}`);
    if (p.profitable) {
      botStatus = `EXECUTING! Net: $${p.net}`;
      const ok = await executeTrade(loanAmount);
      if(ok) {
        totalTrades++;
        totalProfit += parseFloat(p.net);
        botStatus = `✅ Profit: $${p.net}`;
      }
    } else {
      botStatus = `Waiting | Gap: $${p.gross} | Need: $${MIN_PROFIT}`;
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
<title>ARB BOT</title>
<meta http-equiv="refresh" content="2">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050505;color:#00ff88;font-family:monospace;padding:16px}
h1{text-align:center;font-size:18px;margin-bottom:12px}
.s{background:#111;border:1px solid #00ff8844;border-radius:8px;padding:12px;margin-bottom:12px;text-align:center}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.c{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px}
.c h3{color:#555;font-size:10px;margin-bottom:4px}
.c .v{font-size:18px;font-weight:bold}
.l{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px;max-height:250px;overflow-y:auto}
.li{font-size:11px;color:#777;padding:2px 0;border-bottom:1px solid #1a1a1a}
</style>
</head>
<body>
<h1>🤖 USDC/USDT ARB BOT</h1>
<div class="s">${botStatus}</div>
<div class="g">
<div class="c"><h3>PROFIT</h3><div class="v">$${totalProfit.toFixed(2)}</div></div>
<div class="c"><h3>TRADES</h3><div class="v">${totalTrades}</div></div>
<div class="c"><h3>LOAN</h3><div class="v">$10,000</div></div>
<div class="c"><h3>BACK</h3><div class="v">$${currentBack}</div></div>
<div class="c"><h3>GAP</h3><div class="v">$${currentGap}</div></div>
<div class="c"><h3>MIN</h3><div class="v">$${MIN_PROFIT}</div></div>
<div class="c"><h3>UPTIME</h3><div class="v">${Math.floor(up/3600)}h${Math.floor((up%3600)/60)}m</div></div>
<div class="c"><h3>NET</h3><div class="v">Polygon</div></div>
</div>
<div class="l">${logs.map(l=>`<div class="li">${l}</div>`).join("")}</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  log("Bot started!");
  log("Wallet: " + wallet.address);
  log("Contract: " + CONTRACT_ADDRESS);
  log("Min profit: $" + MIN_PROFIT);
});

setInterval(scan, 2000);
scan();
