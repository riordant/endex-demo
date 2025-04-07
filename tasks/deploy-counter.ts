import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { saveDeployment } from './utils'

// Task to deploy the Counter contract
task('deploy-counter', 'Deploy the Counter contract to the selected network').setAction(async (_, hre: HardhatRuntimeEnvironment) => {
	const { ethers, network } = hre

	console.log(`Deploying Counter to ${network.name}...`)

	// Get the deployer account
	const [deployer] = await ethers.getSigners()
	console.log(`Deploying with account: ${deployer.address}`)

	// Deploy the contract
	const Counter = await ethers.getContractFactory('Counter')
	const counter = await Counter.deploy()
	await counter.waitForDeployment()

	const counterAddress = await counter.getAddress()
	console.log(`Counter deployed to: ${counterAddress}`)

	// Save the deployment
	saveDeployment(network.name, 'Counter', counterAddress)

	return counterAddress
})
