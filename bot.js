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

const ADDRESSES = {
  USDC:       "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  USDCe:      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT:       "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  AAVE_POOL:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  CURVE_POOL: "0x445FE580eF8d70FF569aB36e80c647af338db351",
};

const CURVE_ABI = [
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
];

const CONTRACT_ABI = [
  "function startArbitrage(uint256 amount) external",
];

let stats = {
  totalTrades:   0,
  totalProfit:   0,
  forward:       "0",
  backward:      "0",
  gap:           "0",
  status:        "Starting...",
  logs:          [],
  botStarted:    new Date().toISOString(),
  walletAddress: wallet.address,
  contractAddress: CONTRACT_ADDRESS,
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
  } catch(e) {
    log("Price error: " + e.message);
    return null;
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

async function executeTrade(loanAmount) {
  try {
    log("🚀 Executing flash loan trade...");
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    const tx = await contract.startArbitrage(loanAmount, { gasLimit: 500000 });
    log("TX sent: " + tx.hash);
    const receipt = await tx.wait();
    if(receipt.status === 1) {
      log("✅ Trade SUCCESS!");
      return true;
    } else {
      log("❌ Trade FAILED");
      return false;
    }
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
    stats.forward  = p.loan;
    stats.backward = p.returned;
    stats.gap      = p.gross;

    log(`Scan | Loan:$${p.loan} Back:$${p.returned} Net:$${p.net}`);

    if (p.profitable) {
      stats.status = `🚀 EXECUTING! Net: $${p.net}`;
      const success = await executeTrade(loanAmount);
      if(success) {
        stats.totalTrades++;
        stats.totalProfit += parseFloat(p.net);
        stats.status = `✅ Profit: $${p.net}`;
      }
    } else {
      stats.status = `⏸ Waiting | Gap: $${p.gross} | Need: $${MIN_PROFIT}`;
    }
  } catch(e) {
    log("Scan error: " + e.message);
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
    .card .val{font-size:18px;font-weight:bold}
    .wallet{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:10px;margin-bottom:16px;font-size:10px;color:#555;word-break:break-all}
    .logs{background:#111;border:1px solid #00ff8822;border-radius:8px;padding:12px;max-height:300px;overflow-y:auto}
    .log{font-size:11px;color:#777;padding:3px 0;border-bottom:1px solid #1a1a1a}
  </style>
</head>
<body>
  <h1>🤖 USDC/USDT ARB BOT</h1>
  <div class="status">${stats.status}</div>
  <div class="grid">
    <div class="card"><h3>TOTAL PROFIT</h3><div class="val">$${stats.totalProfit.toFixed(2)}</div></div>
    <div class="card"><h3>TOTAL TRADES</h3><div class="val">${stats.totalTrades}</div></div>
    <div class="card"><h3>LOAN</h3><div class="val">$${stats.forward}</div></div>
    <div class="card"><h3>RETURNED</h3><div class="val">$${stats.backward}</div></div>
    <div class="card"><h3>GAP</h3><div class="val">$${stats.gap}</div></div>
    <div class="card"><h3>MIN PROFIT</h3><div class="val">$${MIN_PROFIT}</div></div>
    <div class="card"><h3>UPTIME</h3><div class="val">${hours}h ${mins}m ${secs}s</div></div>
    <div class="card"><h3>NETWORK</h3><div class="val" style="font-size:13px">Polygon</div></div>
  </div>
  <div class="wallet">
    💼 ${stats.walletAddress}<br>
    📝 Contract: ${stats.contractAddress}
  </div>
  <div class="logs">
    ${stats.logs.map(l => `<div class="log">${l}</div>`).join("")}
  </div>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  log("🚀 Bot started!");
  log("💼 Wallet: " + wallet.address);
  log("📝 Contract: " + CONTRACT_ADDRESS);
  log("🎯 Min profit: $" + MIN_PROFIT);
});

setInterval(scan, 2000);
scan();
