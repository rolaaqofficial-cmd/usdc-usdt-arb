const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const ABI = [
  "function startArbitrage(uint256 amount) external",
  "function withdraw(address token) external"
];

const BYTECODE = "0x608060405234801561001057600080fd5b50336000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550610b8b806100606000396000f3fe608060405234801561001057600080fd5b50600436106100415760003560e01c8063715018a6146100465780638da5cb5b14610050578063f2fde38b1461006e575b600080fd5b61004e61008a565b005b61005861009c565b6040516100659190610334565b60405180910390f35b6100886004803603810190610083919061037b565b6100c0565b005b600061009461017c565b9050806100a057600080fd5b565b60008054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b60006100ca61017c565b90508061011e576040517f08c379a0000000000000a52000000000000000000000000000000000000000815260040161011590610407565b60405180910390fd5b8173ffffffffffffffffffffffffffffffffffffffff1660008054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e060405160405180910390a3806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050565b60003373ffffffffffffffffffffffffffffffffffffffff1660008054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1614905090565b";

async function main() {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    
    const balance = await provider.getBalance(wallet.address);
    console.log("Wallet:", wallet.address);
    console.log("Balance:", ethers.formatEther(balance), "MATIC");
    
    console.log("Deploying contract...");
    const factory = new ethers.ContractFactory(ABI, BYTECODE, wallet);
    const contract = await factory.deploy({ gasLimit: 3000000 });
    
    console.log("TX Hash:", contract.deploymentTransaction().hash);
    await contract.waitForDeployment();
    
    console.log("✅ CONTRACT DEPLOYED!");
    console.log("📝 Address:", contract.target);
    console.log("Copy this address and add to bot!");
    
  } catch(e) {
    console.log("Error:", e.message);
  }
}

main();
