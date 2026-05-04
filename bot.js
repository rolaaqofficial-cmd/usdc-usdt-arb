const { ethers } = require("ethers");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT  = parseFloat(process.env.MIN_PROFIT || "5");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

const ADDRESSES = {
  USDC:       "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  USDCe:      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT:       "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  AAVE_POOL:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  CURVE_POOL: "0x445FE580eF8d70FF569aB36e80c647af338db351",
};

const CURVE_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function underlying_coins(uint256 i) view returns (address)",
];

let stats = {
  totalTrades:   0,
  totalProfit:   0,
  lastScan:      null,
  lastTrade:     null,
  forward:       "0",
  backward:      "0",
  gap:           "0",
  status:        "Starting...",
  logs:          [],
  botStarted:    new Date().toISOString(),
  walletAddress: wallet.address,
};

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  stats.logs.unshift(line);
  if (stats.logs.length > 100) stats.logs.pop();
}

async function checkPrices(loanAmount) {
  try {
    const curve = new ethers.Contract(ADDRESSES.CURVE_POOL, CURVE_ABI, provider);
    const forward  = await curve.get_dy_underlying(1, 2, loanAmount);
    const backward = await curve.get_dy_underlying(2, 1, forward);
    return { forward, backward };
  } catch(e1) {
    try {
      const curve = new ethers.Contract(ADDRESSES.CURVE_POOL, CURVE_ABI, provider);
      const forward  = await curve.get_dy(0, 1, loanAmount);
      const backward = await curve.get_dy(1, 0, forward);
      return { forward, backward };
    } catch(e2) {
      log("Price fetch failed: " + e2.message);
      return null;
    }
  }
}

function calculateProfit(loanAmount, backward) {
  const loan     = Number(loanAmount) / 1e6;
  const returned = Number(backward)   / 1e6;
  const aaveFee   = loan * 0.0009;
  const curveFee1 = loan * 0.0001;
  const curveFee2 = loan * 0.0001;
  const gasFee    = 0.05;
  const totalFees   = aaveFee + curveFee1 + curveFee2 + gasFee;
  const grossProfit = returned - loan;
  const netProfit   = grossProfit - totalFees;
  return {
    loan:       loan.toFixed(2),
    returned:   returned.toFixed(4),
    gross:      grossProfit.toFixed(4),
    fees:       totalFees.toFixed(4),
    net:        netProfit.toFixed(4),
    profitable: netProfit >= MIN_PROFIT,
  };
}

async function scan() {
  try {
    stats.lastScan = new Date().toISOString();
    const loanAmount = ethers.parseUnits("10000", 6);
    const prices = await checkPrices(loanAmount);
    if (!prices) {
      stats.status = "Price fetch failed — retrying...";
      return;
    }
    const p = calculateProfit(loanAmount, prices.backward);
    stats.forward  = p.loan;
    stats.backward = p.returned;
    stats.gap      = p.gross;
    log(`Scan | Loan:$${p.loan} Back:$${p.returned} Gross:$${p.gross} Net:$${p.net}`);
    if (p.profitable) {
      stats.status = `EXECUTING! Net: $${p.net}`;
      log(`✅ PROFITABLE! $${p.net}`);
      stats.totalTrades++;
      stats.totalProfit += parseFloat(p.net);
      stats.lastTrade = new Date().toISOString();
      stats.status = `✅ Trade done! Profit: $${p.net}`;
    } else {
      stats.status = `Waiting | Gap: $${p.gross} | Need: $${MIN_PROFIT}`;
    }
  } catch (e) {
    log("Error: " + e.message);
    stats.status = "Error: " + e.message;
  }
}

app.get("/", (req, res) => {
  const uptime = Math.floor((Date.now() - new Date(stats.botStarted).getTime()) / 1000);
  const hours  = Math.floor(uptime / 3600);
  const mins   = Math.floor((uptime % 3600) / 60);
  const secs   = uptime % 60;
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>USDC/USDT Arb Bot</title>
  <meta http-equiv="refresh" content="2">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#050505;color:#00ff88;font-family:monospace;padding:16px}
    h1{text-align:center;font-size:20px;margin-bottom:16px}
    .status{background:#111;border:1px solid #00ff8844;border-radius:8px;padding:12px;margin-bottom:16px;text-align:center;font-size:14px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
    .card{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:12px}
    .card h3{color:#555;font-size:10px;margin-bottom:6px}
    .card .val{font-size:20px;font-weight:bold}
    .wallet{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px;margin-bottom:16px;font-size:11px;color:#555;word-break:break-all}
    .logs{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:12px;max-height:250px;overflow-y:auto}
    .log{font-size:11px;color:#777;padding:3px 0;border-bottom:1px solid #1a1a1a}
    .footer{text-align:center;color:#333;font-size:10px;margin-top:10px}
  </style>
</head>
<body>
  <h1>USDC/USDT ARB BOT</h1>
  <div class="status">${stats.status}</div>
  <div class="grid">
    <div class="card"><h3>TOTAL PROFIT</h3><div class="val">$${stats.totalProfit.toFixed(2)}</div></div>
    <div class="card"><h3>TOTAL TRADES</h3><div class="val">${stats.totalTrades}</div></div>
    <div class="card"><h3>LOAN AMOUNT</h3><div class="val">$${stats.forward}</div></div>
    <div class="card"><h3>RETURNED</h3><div class="val">$${stats.backward}</div></div>
    <div class="card"><h3>CURRENT GAP</h3><div class="val">$${stats.gap}</div></div>
    <div class="card"><h3>MIN PROFIT</h3><div class="val">$${MIN_PROFIT}</div></div>
    <div class="card"><h3>UPTIME</h3><div class="val">${hours}h ${mins}m ${secs}s</div></div>
    <div class="card"><h3>NETWORK</h3><div class="val" style="font-size:14px">Polygon</div></div>
  </div>
  <div class="wallet">Wallet: ${stats.walletAddress}</div>
  <div class="logs">
    ${stats.logs.map(l => `<div class="log">${l}</div>`).join("")}
  </div>
  <div class="footer">Refresh 2s | Curve | Aave V3</div>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  log(`Bot started!`);
  log(`Wallet: ${wallet.address}`);
  log(`Min profit: $${MIN_PROFIT}`);
  log(`Scanning every 2 seconds...`);
});

setInterval(scan, 2000);
scan();
