/**
 * Generates the GitHub Actions matrix JSON for CI workflows.
 *
 * Reads chain definitions from packages/networks/src/chains/*.ts (parsing
 * `networkGroup` from defineChain calls) and endpoint lists from
 * pet-chain-endpoints.json. Validates that every chain in CHAIN_ORDER has
 * both endpoints and a matching networkGroup, then outputs the matrix to
 * stdout.
 *
 * Usage: node scripts/generate-ci-matrix.mjs
 *
 * Output format:
 * [
 *   { name: "polkadot", chains: [{ chain, port, endpoint_var }, ...] },
 *   { name: "kusama",  chains: [{ chain, port, endpoint_var }, ...] }
 * ]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const endpointsPath = path.join(rootDir, 'packages/networks/src/pet-chain-endpoints.json')
const chainsDir = path.join(rootDir, 'packages/networks/src/chains')

/** Ordered list of chains per network group. Order determines port assignment. */
const CHAIN_ORDER = {
	polkadot: [
		'polkadot',
		'assetHubPolkadot',
		'bridgeHubPolkadot',
		'collectivesPolkadot',
		'coretimePolkadot',
		'peoplePolkadot',
		'acala',
		'hydration',
		// 'bifrostPolkadot', // disabled: liebi.com endpoints rate-limit CI (HTTP 429)
	],
	kusama: [
		'kusama',
		'assetHubKusama',
		'bridgeHubKusama',
		'coretimeKusama',
		'peopleKusama',
		'encointerKusama',
		'karura',
		'bifrostKusama',
	],
}

/** Base port for each network group. Chains get consecutive ports from here. */
const PORT_BASES = {
	polkadot: 9000,
	kusama: 9010,
}

/** Convert chain name to the env var name used by workflows (e.g. "assetHubPolkadot" -> "ASSETHUBPOLKADOT_ENDPOINT") */
const toEndpointVar = (chainName) => `${chainName.toUpperCase()}_ENDPOINT`

/**
 * Parse networkGroup from chain definition TS files.
 * Reads each .ts file in the chains directory and extracts (name, networkGroup)
 * pairs from defineChain() calls using regex.
 */
const readNetworkGroups = () => {
	const networkGroups = new Map()
	const chainFiles = fs.readdirSync(chainsDir).filter((fileName) => fileName.endsWith('.ts') && fileName !== 'index.ts')

	for (const fileName of chainFiles) {
		const filePath = path.join(chainsDir, fileName)
		const source = fs.readFileSync(filePath, 'utf8')
		// Match defineChain({ name: '...', ... networkGroup: '...', ... })
		const matches = source.matchAll(
			/defineChain\s*\(\s*\{[\s\S]*?name:\s*'([^']+)'[\s\S]*?networkGroup:\s*'(polkadot|kusama)'[\s\S]*?\}\s*\)/g,
		)

		for (const [, chainName, networkGroup] of matches) {
			networkGroups.set(chainName, networkGroup)
		}
	}

	return networkGroups
}

const endpoints = JSON.parse(fs.readFileSync(endpointsPath, 'utf8'))
const networkGroups = readNetworkGroups()

// Build the matrix: for each network, map its chains to {chain, port, endpoint_var} objects
const matrix = ['polkadot', 'kusama'].map((networkName) => ({
	name: networkName,
	chains: CHAIN_ORDER[networkName].map((chainName, index) => {
		// Validate that endpoints exist for this chain
		if (!(chainName in endpoints)) {
			throw new Error(`Missing endpoints for chain: ${chainName}`)
		}

		const networkGroup = networkGroups.get(chainName)

		// Validate that the chain's TS definition matches the expected network group
		if (networkGroup !== networkName) {
			throw new Error(`Expected ${chainName} to belong to ${networkName}, got ${networkGroup ?? 'undefined'}`)
		}

		return {
			chain: chainName,
			port: PORT_BASES[networkName] + index,
			endpoint_var: toEndpointVar(chainName),
		}
	}),
}))

process.stdout.write(JSON.stringify(matrix))
