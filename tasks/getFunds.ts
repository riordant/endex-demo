import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
dotenv.config();

task("getFunds", "Sends 10 coins to the specified address")
  .addParam("address", "The address to send funds to")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { address } = taskArgs;
    
    // Load private key from environment or config
    const privateKey = process.env.FUNDER_PRIVATE_KEY;
    if (!privateKey) {
      console.error("Error: FUNDER_PRIVATE_KEY environment variable not set");
      return;
    }

    console.log("Funding: ", address);
    
    try {
      // Create wallet from private key using hre.ethers
      const wallet = new hre.ethers.Wallet(privateKey, hre.ethers.provider);
      // Get wallet balance
      const balance = await hre.ethers.provider.getBalance(wallet.address);
      console.log(`Funder wallet address: ${wallet.address}`);
      console.log(`Funder wallet balance: ${hre.ethers.formatEther(balance)} ETH`);
      
      // Check if wallet has enough funds
      const amountToSend = hre.ethers.parseEther("10");
      if (balance < amountToSend) {
        console.error(`Error: Funder wallet doesn't have enough funds. Current balance: ${hre.ethers.formatEther(balance)} ETH`);
        return;
      }
      
      // Send transaction
      console.log(`Sending 10 coins to ${address}...`);
      const tx = await wallet.sendTransaction({
        to: address,
        value: amountToSend
      });
      
      console.log(`Transaction sent! Hash: ${tx.hash}`);
      console.log("Waiting for confirmation...");
      
      // Wait for transaction to be mined
      const receipt = await tx.wait();
      console.log(`Transaction confirmed in block ${receipt?.blockNumber}`);
      console.log(`Successfully sent 10 coins to ${address}`);
      
    } catch (error) {
      console.error("Error sending funds:", error);
    }
  }); 