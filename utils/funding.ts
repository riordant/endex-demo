import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Sends funds to the specified address
 * @param hre Hardhat Runtime Environment
 * @param toAddress Address to send funds to
 * @param amount Amount to send in ETH (default: 10)
 * @returns Transaction receipt or null if failed
 */
export async function sendFunds(
  hre: HardhatRuntimeEnvironment, 
  toAddress: string, 
  amount: string = "10"
) {
  // Load private key from environment
  const privateKey = process.env.FUNDER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Error: FUNDER_PRIVATE_KEY environment variable not set");
    return null;
  }

  try {
    // Create wallet from private key
    const wallet = new hre.ethers.Wallet(privateKey, hre.ethers.provider);
    
    // Get wallet balance
    const balance = await hre.ethers.provider.getBalance(wallet.address);
    console.log(`Funder wallet address: ${wallet.address}`);
    console.log(`Funder wallet balance: ${hre.ethers.formatEther(balance)} ETH`);
    
    // Check if wallet has enough funds
    const amountToSend = hre.ethers.parseEther(amount);
    if (balance < amountToSend) {
      console.error(`Error: Funder wallet doesn't have enough funds. Current balance: ${hre.ethers.formatEther(balance)} ETH`);
      return null;
    }
    
    // Send transaction
    console.log(`Sending ${amount} ETH to ${toAddress}...`);
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountToSend
    });
    
    console.log(`Transaction sent! Hash: ${tx.hash}`);
    console.log("Waiting for confirmation...");
    
    // Wait for transaction to be mined
    const receipt = await tx.wait();
    console.log(`Transaction confirmed in block ${receipt?.blockNumber}`);
    console.log(`Successfully sent ${amount} ETH to ${toAddress}`);
    
    return receipt;
  } catch (error) {
    console.error("Error sending funds:", error);
    return null;
  }
} 