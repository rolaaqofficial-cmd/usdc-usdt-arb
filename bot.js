const { ethers } = require("ethers");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ──────────────────────────────────────────────
const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT  = parseFloat(process.env.MIN_PROFIT || "5");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

// ── Addresses (Polygon) ─────────────────────────────────
const ADDRESSES = {
  USDC:       "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT:       "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  AAVE_POOL:  "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  CURVE_POOL: "0x445FE580eF8d70FF569aB36e80c647af338db351", // Curve USDC/USDT Polygon
};

// ── ABIs ────────────────────────────────────────────────
const CURVE_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

const AAVE_ABI = [
  "function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external",
];

const RECEIVER_ABI = [
  "function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool)",
];

// ── Stats ────────────────────────────────────────────────
let stats = {
  totalTrades:  0,
  totalProfit:  0,
  lastScan:     null,
  lastTrade:    null,
  usdcPrice:    0,
  usdtPrice:    0,
  gap:          0,
  status:       "Scanning...",
  logs:         [],
  botStarted:   new Date().toISOString(),
};

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  stats.logs.unshift(line);
  if (stats.logs.length > 50) stats.logs.pop();
}

// ── Price Check ──────────────────────────────────────────
async function checkPrices(loanAmount) {
  try {
    const curve = new ethers.Contract(ADDRESSES.CURVE_POOL, CURVE_ABI, provider);

    // USDC → USDT (index 0 → 1)
    const usdcToUsdt = await curve.get_dy(0, 1, loanAmount);

    // USDT → USDC (index 1 → 0)  
    const usdtToUsdc = await curve.get_dy(1, 0, usdcToUsdt);

    return {
      usdcToUsdt: usdcToUsdt,
      usdtToUsdc: usdtToUsdc,
    };
  } catch (e) {
    log("Price fetch error: " + e.message);
    return null;
  }
}

// ── Profit Calculator ────────────────────────────────────
function calculateProfit(loanAmount, usdtBack) {
  // Amounts in 6 decimals (USDC/USDT)
  const loan       = Number(loanAmount) / 1e6;
  const returned   = Number(usdtBack)   / 1e6;

  const aaveFee    = loan * 0.0009;     // 0.09%
  const curveFee1  = loan * 0.0001;     // 0.01%
  const curveFee2  = loan * 0.0001;     // 0.01%
  const gasFee     = 0.05;

  const totalFees  = aaveFee + curveFee1 + curveFee2 + gasFee;
  const grossProfit = returned - loan;
  const netProfit   = grossProfit - totalFees;

  return {
    loan,
    returned,
    grossProfit: grossProfit.toFixed(4),
    totalFees:   totalFees.toFixed(4),
    netProfit:   netProfit.toFixed(4),
    profitable:  netProfit >= MIN_PROFIT,
  };
}

// ── Main Scanner ─────────────────────────────────────────
async function scan() {
  try {
    stats.lastScan = new Date().toISOString();

    // $10,000 USDC (6 decimals)
    const loanAmount = ethers.parseUnits("10000", 6);

    const prices = await checkPrices(loanAmount);
    if (!prices) return;

    const profit = calculateProfit(loanAmount, prices.usdtToUsdc);

    stats.gap        = profit.grossProfit;
    stats.usdcPrice  = profit.loan.toFixed(2);
    stats.usdtPrice  = profit.returned.toFixed(2);

    log(`Scan | Loan: $${profit.loan} | Back: $${profit.returned} | Net: $${profit.netProfit} | Fees: $${profit.totalFees}`);

    if (profit.profitable) {
      stats.status = "🚀 EXECUTING TRADE!";
      log(`✅ PROFITABLE! Net profit: $${profit.netProfit} — Executing!`);
      await executeTrade(loanAmount, profit);
    } else {
      stats.status = `⏸ Waiting... Gap: $${profit.grossProfit} | Need: $${MIN_PROFIT}`;
      log(`❌ Skip — Not profitable. Gap: $${profit.grossProfit}`);
    }

  } catch (e) {
    log("Scan error: " + e.message);
  }
}

// ── Trade Executor ───────────────────────────────────────
async function executeTrade(loanAmount, profit) {
  try {
    const aavePool = new ethers.Contract(ADDRESSES.AAVE_POOL, AAVE_ABI, wallet);

    // Encode params: curve pool address
    const params = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address"],
      [ADDRESSES.CURVE_POOL]
    );

    const tx = await aavePool.flashLoanSimple(
      wallet.address,    // receiver (contract chahiye — placeholder)
      ADDRESSES.USDC,
      loanAmount,
      params,
      0,
      { gasLimit: 500000 }
    );

    log(`🚀 TX sent: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      stats.totalTrades++;
      stats.totalProfit += parseFloat(profit.netProfit);
      stats.lastTrade    = new Date().toISOString();
      stats.status       = `✅ Trade SUCCESS! Profit: $${profit.netProfit}`;
      log(`✅ Trade SUCCESS! Total profit: $${stats.totalProfit.toFixed(2)}`);
    } else {
      stats.status = "❌ Trade failed";
      log("❌ Trade FAILED");
    }

  } catch (e) {
    stats.status = "❌ Error: " + e.message;
    log("Trade error: " + e.message);
  }
}

// ── Dashboard ────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>USDC/USDT Arbitrage Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #00ff88; font-family: monospace; padding: 20px; }
    h1 { text-align: center; font-size: 24px; margin-bottom: 20px; color: #00ff88; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
    .card { background: #111; border: 1px solid #00ff8833; border-radius: 8px; padding: 15px; }
    .card h3 { color: #888; font-size: 12px; margin-bottom: 8px; }
    .card .value { font-size: 22px; font-weight: bold; }
    .profit { color: #00ff88; }
    .status { background: #111; border: 1px solid #00ff8833; border-radius: 8px; padding: 15px; margin-bottom: 20px; text-align: center; font-size: 16px; }
    .logs { background: #111; border: 1px solid #00ff8833; border-radius: 8px; padding: 15px; max-height: 300px; overflow-y: auto; }
    .log-line { font-size: 12px; color: #aaa; padding: 3px 0; border-bottom: 1px solid #222; }
    .refresh { text-align: center; margin-top: 15px; color: #555; font-size: 12px; }
  </style>
  <meta http-equiv="refresh" content="3">
</head>
<body>
  <h1>🤖 USDC/USDT Arbitrage Bot</h1>
  
  <div class="status">${stats.status}</div>
  
  <div class="grid">
    <div class="card">
      <h3>TOTAL PROFIT</h3>
      <div class="value profit">$${stats.totalProfit.toFixed(2)}</div>
    </div>
    <div class="card">
      <h3>TOTAL TRADES</h3>
      <div class="value">${stats.totalTrades}</div>
    </div>
    <div class="card">
      <h3>LOAN AMOUNT</h3>
      <div class="value">$${stats.usdcPrice}</div>
    </div>
    <div class="card">
      <h3>RETURNED</h3>
      <div class="value">$${stats.usdtPrice}</div>
    </div>
    <div class="card">
      <h3>CURRENT GAP</h3>
      <div class="value">$${stats.gap}</div>
    </div>
    <div class="card">
      <h3>MIN PROFIT</h3>
      <div class="value">$${MIN_PROFIT}</div>
    </div>
  </div>

  <div class="logs">
    ${stats.logs.map(l => `<div class="log-line">${l}</div>`).join("")}
  </div>
  
  <div class="refresh">Auto refresh every 3 seconds</div>
</body>
</html>
  `);
});

// ── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`✅ Dashboard: http://localhost:${PORT}`);
  log(`💰 Wallet: ${wallet.address}`);
  log(`🎯 Min profit: $${MIN_PROFIT}`);
  log(`🚀 Bot started!`);
});

// Scan every 2 seconds
setInterval(scan, 2000);
scan();
