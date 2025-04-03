# Fhenix CoFHE Hardhat Starter

This project is a starter repository for developing FHE (Fully Homomorphic Encryption) smart contracts on the Fhenix network using CoFHE (Confidential Computing Framework for Homomorphic Encryption).

## Prerequisites

- Node.js (v18 or later)
- pnpm (recommended package manager)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/fhenixprotocol/cofhe-hardhat-starter.git
cd cofhe-hardhat-starter
```

2. Install dependencies:

```bash
pnpm install
```

## Available Scripts

### Development

- `pnpm compile` - Compile the smart contracts
- `pnpm clean` - Clean the project artifacts
- `pnpm test` - Run tests on the local CoFHE network
- `pnpm test:hardhat` - Run tests on the Hardhat network
- `pnpm test:localcofhe` - Run tests on the local CoFHE network

### Local CoFHE Network

- `pnpm localcofhe:start` - Start a local CoFHE network
- `pnpm localcofhe:stop` - Stop the local CoFHE network
- `pnpm localcofhe:faucet` - Get test tokens from the faucet
- `pnpm localcofhe:deploy` - Deploy contracts to the local CoFHE network

### Contract Tasks

- `pnpm task:deploy` - Deploy contracts
- `pnpm task:addCount` - Add to the counter
- `pnpm task:getCount` - Get the current count
- `pnpm task:getFunds` - Get funds from the contract

## Project Structure

- `contracts/` - Smart contract source files
  - `Counter.sol` - Example FHE counter contract
  - `Lock.sol` - Example time-locked contract
- `test/` - Test files
- `ignition/` - Hardhat Ignition deployment modules

## How to use

### Faucet

- `pnpm localcofhe:faucet --address YOUR_ADDRESS`


## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
