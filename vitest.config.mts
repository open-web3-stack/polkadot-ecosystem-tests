import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

import { resolve } from 'path';
import tsconfigPaths from 'vite-tsconfig-paths'
import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: resolve(__dirname, 'KNOWN_GOOD_BLOCK_NUMBERS.env') });

export default defineConfig({
	test: {
		hookTimeout: 240_000,
		testTimeout: 240_000,
		pool: 'forks',
		passWithNoTests: true,
		retry: process.env.CI ? 3 : 2,
		reporters: process.env.GITHUB_ACTIONS ? ['basic', 'github-actions'] : ['basic'],
		// setupFiles: ["./KNOWN_GOOD_BLOCK_NUMBERS.env"]
	},
	build: {
		outDir: '../../dist',
	},
	plugins: [tsconfigPaths(), swc.vite()],
})
