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

// Curve Aave Pool — Polygon (USDC=1, USDT=2, DAI=0)
const CURVE_POOL = "0x445FE580eF8d70FF569aB36e80c647af338db351";

const CURVE_ABI = [
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
];

const CONTRACT_ABI = [
  "function startArbitrage(uint256 amount) external",
];

let totalTrades  = 0;
let totalProfit  = 0;
let botStatus    = "Starting...";
let logs         = [];
let scanCount    = 0;
let lastGap      = "0";
let lastDir      = "";
const botStarted = new Date().toISOString();

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  logs.unshift(line);
  if (logs.length > 150) logs.pop();
}

async function checkOpportunity(loanAmount) {
  try {
    const curve = new ethers.Contract(CURVE_POOL, CURVE_ABI, provider);
    const loan  = Number(loanAmount) / 1e6;

    // Direction 1: USDC → USDT → USDC
    const usdtOut  = await curve.get_dy_underlying(1, 2, loanAmount);
    const usdcBack = await curve.get_dy_underlying(2, 1, usdtOut);
    const gross1   = (Number(usdcBack) / 1e6) - loan;

    // Direction 2: USDT → USDC → USDT  
    const usdtLoan = ethers.parseUnits(loan.toString(), 6);
    const usdcOut  = await curve.get_dy_underlying(2, 1, usdtLoan);
    const usdtBack = await curve.get_dy_underlying(1, 2, usdcOut);
    const gross2   = (Number(usdtBack) / 1e6) - loan;

    // Fees
    const fees = (loan * 0.0009) + (loan * 0.0002) + 0.05;

    const net1 = gross1 - fees;
    const net2 = gross2 - fees;

    // Pick best direction
    if(net1 >= net2) {
      return {
        direction: "USDC→USDT→USDC",
        gross: gross1.toFixed(6),
        net:   net1.toFixed(6),
        fees:  fees.toFixed(4),
        profitable: net1 >= MIN_PROFIT,
        usdtOut: Number(usdtOut) / 1e6,
        usdcBack: Number(usdcBack) / 1e6,
      };
    } else {
      return {
        direction: "USDT→USDC→USDT",
        gross: gross2.toFixed(6),
        net:   net2.toFixed(6),
        fees:  fees.toFixed(4),
        profitable: net2 >= MIN_PROFIT,
        usdtOut: Number(usdcOut) / 1e6,
        usdcBack: Number(usdtBack) / 1e6,
      };
    }

  } catch(e) {
    log("Price error: " + e.message);
    return null;
  }
}

async function executeTrade(loanAmount) {
  try {
    log("🚀 Flash loan executing...");
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    const gasPrice = await provider.getFeeData();
    
    const tx = await contract.startArbitrage(loanAmount, {
      gasLimit:             600000,
      maxFeePerGas:         gasPrice.maxFeePerGas,
      maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
    });
    
    log("📤 TX: " + tx.hash);
    const receipt = await tx.wait();

    if(receipt.status === 1) {
      log("✅ Trade SUCCESS! TX: " + tx.hash);
      return true;
    } else {
      log("❌ Trade reverted");
      return false;
    }
  } catch(e) {
    log("❌ Trade error: " + e.message);
    return false;
  }
}

async function scan() {
  try {
    scanCount++;
    const loanAmount = ethers.parseUnits("50000", 6);
    const opp = await checkOpportunity(loanAmount);

    if(!opp) return;

    lastGap = opp.gross;
    lastDir = opp.direction;

    if(scanCount % 5 === 0) {
      log(`[${scanCount}] ${opp.direction} | Mid:$${opp.usdtOut.toFixed(2)} | Back:$${opp.usdcBack.toFixed(2)} | Gross:$${opp.gross} | Net:$${opp.net} | Fees:$${opp.fees}`);
    }

    if(opp.profitable) {
      log(`💰 PROFITABLE! Dir:${opp.direction} Net:$${opp.net}`);
      botStatus = `🚀 EXECUTING! ${opp.direction} Net:$${opp.net}`;

      const ok = await executeTrade(loanAmount);
      if(ok) {
        totalTrades++;
        totalProfit += parseFloat(opp.net);
        botStatus = `✅ Trade #${totalTrades} Profit:$${opp.net} | Total:$${totalProfit.toFixed(2)}`;
        log(`🏆 Total profit: $${totalProfit.toFixed(2)} | Trades: ${totalTrades}`);
      } else {
        botStatus = `❌ Trade failed — retrying...`;
      }
    } else {
      botStatus = `⏸ Waiting | ${opp.direction} | Gap:$${opp.gross} | Need:$${MIN_PROFIT}`;
    }

  } catch(e) {
    log("Scan error: " + e.message);
  }
}

app.get("/", (req, res) => {
  const up    = Math.floor((Date.now() - new Date(botStarted).getTime()) / 1000);
  const hours = Math.floor(up / 3600);
  const mins  = Math.floor((up % 3600) / 60);
  const secs  = up % 60;

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flash Arb Bot</title>
<meta http-equiv="refresh" content="2">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#030303;color:#00ff88;font-family:'Courier New',monospace;padding:16px}
h1{text-align:center;font-size:20px;margin-bottom:4px;letter-spacing:3px}
.sub{text-align:center;color:#333;font-size:10px;margin-bottom:14px}
.status{background:#0a0a0a;border:1px solid #00ff8866;border-radius:10px;padding:14px;margin-bottom:14px;text-align:center;font-size:13px;line-height:1.5}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.card{background:#0a0a0a;border:1px solid #00ff8822;border-radius:10px;padding:12px}
.card .label{color:#444;font-size:9px;letter-spacing:1px;margin-bottom:6px}
.card .value{font-size:20px;font-weight:bold;color:#00ff88}
.card .value.green{color:#00ff88}
.card .value.yellow{color:#ffcc00}
.card .value.red{color:#ff4444}
.logs{background:#0a0a0a;border:1px solid #00ff8822;border-radius:10px;padding:12px;max-height:280px;overflow-y:auto}
.log-line{font-size:10px;color:#555;padding:3px 0;border-bottom:1px solid #111;line-height:1.4}
.footer{text-align:center;color:#222;font-size:9px;margin-top:10px}
</style>
</head>
<body>
<h1>⚡ FLASH ARB BOT</h1>
<div class="sub">Polygon • Curve Finance • Aave V3</div>
<div class="status">${botStatus}</div>
<div class="grid">
  <div class="card"><div class="label">TOTAL PROFIT</div><div class="value green">$${totalProfit.toFixed(2)}</div></div>
  <div class="card"><div class="label">TOTAL TRADES</div><div class="value">${totalTrades}</div></div>
  <div class="card"><div class="label">LOAN AMOUNT</div><div class="value">$50,000</div></div>
  <div class="card"><div class="label">BEST GAP</div><div class="value yellow">$${lastGap}</div></div>
  <div class="card"><div class="label">MIN PROFIT</div><div class="value">$${MIN_PROFIT}</div></div>
  <div class="card"><div class="label">SCANS</div><div class="value">${scanCount}</div></div>
  <div class="card"><div class="label">UPTIME</div><div class="value" style="font-size:16px">${hours}h ${mins}m ${secs}s</div></div>
  <div class="card"><div class="label">DIRECTION</div><div class="value" style="font-size:11px">${lastDir}</div></div>
</div>
<div class="logs">
${logs.map(l => `<div class="log-line">${l}</div>`).join("")}
</div>
<div class="footer">Auto refresh 2s • Wallet: ${wallet.address}</div>
</body>
</html>`);
});

app.listen(PORT, () => {
  log("⚡ Flash Arb Bot started!");
  log("📍 Network: Polygon Mainnet");
  log("🏊 Pool: Curve Aave (USDC/USDT)");
  log("💰 Loan: $50,000");
  log("🎯 Min profit: $" + MIN_PROFIT);
  log("📝 Contract: " + CONTRACT_ADDRESS);
  log("💼 Wallet: " + wallet.address);
});

setInterval(scan, 2000);
scan();
