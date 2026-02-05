import { defineConfig } from 'vitest/config'

import { resolve } from 'node:path'
import dotenv from 'dotenv'
import swc from 'unplugin-swc'
import tsconfigPaths from 'vite-tsconfig-paths'

dotenv.config()
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env') })
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS_POLKADOT.env') })
if (process.env.LOG_LEVEL === undefined) {
	process.env.LOG_LEVEL = 'error'
}

export default defineConfig({
	test: {
		hookTimeout: 300_000,
		testTimeout: 300_000,
		pool: 'forks',
		passWithNoTests: true,
		retry: 1,
		reporters: process.env.GITHUB_ACTIONS ? ['verbose', 'github-actions'] : ['default'],
		// Run tests sequentially when SEQUENTIAL env var is set
		fileParallelism: process.env.SEQUENTIAL === 'true' ? false : undefined,
	},
	build: {
		outDir: '../../dist',
	},
	plugins: [tsconfigPaths(), swc.vite()],
	clearScreen: false,
})
