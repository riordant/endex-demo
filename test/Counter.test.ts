import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expectResultSuccess, expectResultValue, initializeWithHardhatSigner, mock_expectPlaintext } from '@fhenixprotocol/cofhe-hardhat-plugin'
import hre from 'hardhat'
import { cofhejs, Encryptable, EncryptStep, FheTypes } from 'cofhejs/node'

describe('Counter', function () {
	// We define a fixture to reuse the same setup in every test.
	// We use loadFixture to run this setup once, snapshot that state,
	// and reset Hardhat Network to that snapshot in every test.
	async function deployCounterFixture() {
		// Contracts are deployed using the first signer/account by default
		const [signer, signer2, bob, alice] = await hre.ethers.getSigners()

		const Counter = await hre.ethers.getContractFactory('Counter')
		const counter = await Counter.connect(bob).deploy()

		return { counter, signer, bob, alice }
	}

	describe('Functionality', function () {
		it('Should increment the counter', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)

			const count = await counter.count()
			await mock_expectPlaintext(bob.provider, count, 0n)

			await counter.connect(bob).increment()

			const count2 = await counter.count()
			await mock_expectPlaintext(bob.provider, count2, 1n)
		})
		it('cofhejs unseal (mocks)', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)

			expectResultSuccess(await initializeWithHardhatSigner(bob, { environment: 'MOCK' }))

			const count = await counter.count()
			const unsealedResult = await cofhejs.unseal(count, FheTypes.Uint32)
			console.log('unsealedResult', unsealedResult)
			expectResultValue(unsealedResult, 0n)

			await counter.connect(bob).increment()

			const count2 = await counter.count()
			const unsealedResult2 = await cofhejs.unseal(count2, FheTypes.Uint32)
			expectResultValue(unsealedResult2, 1n)
		})
		it('cofhejs encrypt (mocks)', async function () {
			const { counter, bob } = await loadFixture(deployCounterFixture)

			expectResultSuccess(await initializeWithHardhatSigner(bob, { environment: 'MOCK' }))

			const setState = (step: EncryptStep) => {
				console.log(`Encrypt step - ${step}`)
			}

			const [encryptedInput] = expectResultSuccess(await cofhejs.encrypt(setState, [Encryptable.uint32(5n)] as const))
			await mock_expectPlaintext(bob.provider, encryptedInput.ctHash, 5n)

			await counter.connect(bob).reset(encryptedInput)

			const count = await counter.count()
			await mock_expectPlaintext(bob.provider, count, 5n)

			const unsealedResult = await cofhejs.unseal(count, FheTypes.Uint32)
			expectResultValue(unsealedResult, 5n)
		})
	})
})
