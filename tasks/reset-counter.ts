import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Counter } from '../typechain-types'
import { cofhejs, Encryptable, EncryptStep } from 'cofhejs/node'
import { cofhejs_initializeWithHardhatSigner } from 'cofhe-hardhat-plugin'
import { getDeployment } from './utils'

// Task to reset the counter with an encrypted input
task('reset-counter', 'reset the counter').setAction(async (_, hre: HardhatRuntimeEnvironment) => {
	const { ethers, network } = hre

	// Get the Counter contract address
	const counterAddress = getDeployment(network.name, 'Counter')
	if (!counterAddress) {
		console.error(`No Counter deployment found for network ${network.name}`)
		console.error(`Please deploy first using: npx hardhat deploy-counter --network ${network.name}`)
		return
	}

	console.log(`Using Counter at ${counterAddress} on ${network.name}`)

	// Get the signer
	const [signer] = await ethers.getSigners()
	console.log(`Using account: ${signer.address}`)
	await cofhejs_initializeWithHardhatSigner(signer)

	// Get the contract instance with proper typing
	const Counter = await ethers.getContractFactory('Counter')
	const counter = Counter.attach(counterAddress) as unknown as Counter

	const logState = (state: EncryptStep) => {
		console.log(`Log Encrypt State :: ${state}`)
	}

	const encryptedValue = await cofhejs.encrypt([Encryptable.uint32('2000')] as const, logState)

	if (encryptedValue && encryptedValue.data) {
		console.log('Resetting counter...')
		const tx = await counter.reset(encryptedValue.data[0])
		await tx.wait()
		console.log(`Transaction hash: ${tx.hash}`)
	}

	// Get new count
	const newCount = await counter.count()
	console.log(`New count: ${newCount}`)
})
