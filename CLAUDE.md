# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Polkadot Ecosystem Tests is an automated testing suite for Polkadot/Kusama networks powered by [Chopsticks](https://github.com/AcalaNetwork/chopsticks). It tests XCM transfers between chains and end-to-end scenarios for relay chains and system parachains.

## Commands

```bash
# Install dependencies
yarn install

# Run all tests
yarn test

# Run tests for a specific network
yarn test:polkadot
yarn test:kusama

# Run tests matching a pattern (test name from describe/it blocks)
yarn test -t <test-name>

# Run tests for a specific chain file
yarn test <chain>

# Run with Vitest UI
yarn test:ui

# Update snapshots (after test changes or intentional behavior changes)
yarn test -u

# Lint and type check
yarn lint

# Auto-fix lint issues
yarn fix

# Update block numbers to latest
yarn update-known-good      # Update KNOWN_GOOD_BLOCK_NUMBERS_*.env (used by CI)
yarn update-env             # Update local .env

# Check proxy test coverage
yarn check-proxy-coverage
```

## Architecture

### Package Structure

- **packages/shared**: All E2E test suites and shared utilities
  - `src/*.ts`: E2E test modules (accounts, bounties, governance, multisig, proxy, staking, vesting, etc.)
  - `src/xcm/`: XCM test runners (`runXcmPalletUp`, `runXcmPalletDown`, `runXcmPalletHorizontal`)
  - `src/helpers/`: Test utilities and assertion helpers

- **packages/networks**: Chain configurations
  - `src/chains/`: Chain definitions (polkadot, kusama, assetHub, bridgeHub, coretime, people, etc.)

- **packages/polkadot**: Polkadot network test files (import shared tests)
- **packages/kusama**: Kusama network test files (import shared tests)

### Key Utilities

- `setupNetworks(...chains)`: Creates connected Chopsticks test contexts with automatic snapshot restore between tests
- `createNetworks(...chains)`: Lower-level function to create multiple connected networks (relay + parachains)
- `sendTransaction(tx)`: From `@acala-network/chopsticks-testing`, sends a transaction
- `client.dev.newBlock()`: Advances the chain by one block
- `client.dev.setStorage()`: Directly manipulates chain storage for test setup
- `scheduleInlineCallWithOrigin()`: Execute privileged calls (e.g., Root origin) via the scheduler pallet
- `createXcmTransactSend()`: Send XCM Transact messages to execute calls in parachains
- `check()`, `checkEvents()`, `checkSystemEvents()`: Snapshot assertion helpers with `.redact()` support
- Test accounts: `defaultAccounts`, `defaultAccountsSr25519`, `testAccounts` (from `@e2e-test/networks`)

### Test File Naming Convention

- XCM tests: `<chain-a>.<chain-b>.xcm.test.ts`
- E2E tests: `<chain-name>.<test-suite>.e2e.test.ts`

This naming is required for automated test failure reporting to work correctly.

### Key Testing Patterns

```typescript
// Setup networks with automatic snapshot restore between tests
const [polkadotClient, ahClient] = await setupNetworks(polkadot, assetHubPolkadot)

// Send transactions
import { sendTransaction } from '@acala-network/chopsticks-testing'
await sendTransaction(tx.signAsync(signer))
await client.dev.newBlock()

// Snapshot testing with redaction
await check(result).redact().toMatchSnapshot('description')
check(result).redact({ number: 1 }).toMatchSnapshot()  // Keep 1 significant digit
check(result).redact({ removeKeys: /timestamp|blockHash/ }).toMatchSnapshot()

// Execute privileged calls via scheduler
await scheduleInlineCallWithOrigin(client, encodedCall, { system: 'Root' })

// Execute calls in parachain via XCM from relay
const xcmSend = createXcmTransactSend(relayClient, dest, encodedCall, 'Superuser')
```

### Environment Configuration

Block numbers are controlled via environment files:
- `KNOWN_GOOD_BLOCK_NUMBERS_POLKADOT.env` / `KNOWN_GOOD_BLOCK_NUMBERS_KUSAMA.env`: Used by CI
- `.env`: Local overrides

Override specific chains: `<NETWORK>_BLOCK_NUMBER`, `<NETWORK>_WASM`, `<NETWORK>_ENDPOINT`

## Test Writing Guidelines

### Development Workflow

When developing tests or exploring scenario ideas:
- Run Chopsticks networks alongside Polkadot.js Apps for experimentation
- Prefer snapshot testing: automatic redaction of time-sensitive data, efficient storage of detailed execution info, CI integration catches regressions
- Be aware: `await client.dev.newBlock()` can take 1-10 seconds depending on CPU/network conditions

### Best Practices

- Write network-agnostic test logic in `packages/shared/src/`
- Implement chain-specific test files in `packages/polkadot/` or `packages/kusama/`
- Use `.redact()` for volatile values to prevent flaky tests
- Use `{ only: true }` to isolate tests during debugging
- Use `await chain.pause()` for state inspection (connect via Polkadot.js Apps)
- Delete `__snapshots__` folders and run `yarn test -u` when renaming/removing tests

### Debugging

- Pause tests for inspection: `await chain.pause()` (port shown in STDOUT, connect via Polkadot.js Apps)
- Modify `testTimeout` in `vitest.config.mts` for long-running tests (currently 300s)
- Snapshot mismatches: verify uncommitted changes with `git status`, ensure snapshots are in git tree
- RPC failures may indicate configuration issues (check endpoints, block numbers in env files)

## Chopsticks Limitations

Block execution throughput is limited to ~1-10 blocks/second locally. Tests requiring many blocks (referenda confirmation, unbonding) may not be practical here.
