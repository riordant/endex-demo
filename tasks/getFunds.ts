import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as dotenv from "dotenv";
import { sendFunds } from "../utils/funding";

dotenv.config();

task("getFunds", "Sends 10 coins to the specified address")
  .addParam("address", "The address to send funds to")
  .addOptionalParam("amount", "Amount to send in ETH", "10")
  .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
    const { address, amount } = taskArgs;
    console.log("Funding: ", address);
    
    await sendFunds(hre, address, amount);
  }); 