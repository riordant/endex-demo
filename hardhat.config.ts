import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@nomicfoundation/hardhat-ethers'
import 'cofhe-hardhat-plugin'

import "./tasks/getFunds";

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.25',
		settings: {
			evmVersion: 'cancun',
		},
	},
	defaultNetwork: 'hardhat',
	// defaultNetwork: 'localcofhe',
}

export default config
