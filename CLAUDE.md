# CLAUDE.md

Guidance for working in this repo. Read the rules before writing code.

## Rules

1. You MUST write simply, plainly, concisely. No em-dashes, no US-centric filler, no startup fluff. Say the thing.
2. You MUST match the prior art. Read existing suites for how test trees are structured, documented, and written, then follow it.
3. You MUST comment your code, and comments MUST stand alone. Use the repo's style. A comment MUST make sense without the PR, the issue, or your working context. No verbatim external text, no contrasts against things the reader cannot see.
4. You MUST snapshot events in whole, never bare names or other degenerate projections (temporally contingent data invites false positives). You MUST also cast events to their proper types and assert on the relevant fields.
5. You SHOULD prefer clarity over abstraction. You MUST NOT add helpers that hide what a test does; mild repetition that keeps intent legible beats a clever helper that muddles it.
6. You MUST validate before you claim. Confirm against runtime source, live chain, or a fork run. Never assert from memory or one possibly-stale read.

## Authoring tests

`staking.ts`, `multisig.ts`, `proxy.ts`, and `scheduler.ts` are the reference suites. Read them before writing a new one.

- Coverage: a pallet's tests SHOULD exercise its dispatchables, the events they emit, and their error paths, including failure cases (bad origin, wrong state, ineligible caller), not just the happy path.
- Documentation: each test function SHOULD carry a docstring that names what it checks and enumerates the flow as numbered steps, with those step markers repeated as comments through the body next to the code each describes, so the flow reads top to bottom.

## Overview

Automated test suite for Polkadot/Kusama, powered by [Chopsticks](https://github.com/AcalaNetwork/chopsticks). Tests XCM transfers and end-to-end scenarios for relay chains and system parachains.

## Commands

```bash
yarn test                   # all tests
yarn test:polkadot          # one network
yarn test <chain>           # one chain file
yarn test -t <test-name>    # by test name
yarn test -u                # update snapshots
yarn lint                   # tsc + biome
yarn fix                    # auto-fix lint
yarn update-known-good      # refresh CI block numbers
```

## Layout

- `packages/shared/src/*.ts`: E2E test suites (network-agnostic logic lives here)
- `packages/shared/src/xcm/`: XCM runners
- `packages/shared/src/helpers/`: utilities and assertion helpers
- `packages/networks/src/chains/`: chain definitions
- `packages/{polkadot,kusama}/src/`: per-network test files that import the shared suites

File names: `<a>.<b>.xcm.test.ts` for XCM, `<chain>.<suite>.e2e.test.ts` for E2E. Required for failure reporting.

## Key utilities

- `setupNetworks(...chains)`: connected contexts with snapshot restore between tests
- `createNetworks(...chains)`: lower-level network creation
- `sendTransaction(tx)`, `client.dev.newBlock()`, `client.dev.setStorage()`
- `scheduleInlineCallWithOrigin()`: privileged calls via the scheduler
- `createXcmTransactSend()`: XCM Transact to a parachain
- `check()`, `checkEvents()`, `checkSystemEvents()`: snapshot helpers with `.redact()`
- `assertExpectedEvents()`: one way to satisfy rule 4; suites also assert fields directly with `event.<T>.is(...)`, `dispatchError.asModule`, and `expect()`
- Accounts: `defaultAccounts`, `defaultAccountsSr25519`, `testAccounts` from `@e2e-test/networks`

## Environment

Block numbers come from `KNOWN_GOOD_BLOCK_NUMBERS_{POLKADOT,KUSAMA}.env` (CI) or `.env` (local).
Override per chain: `<NETWORK>_BLOCK_NUMBER`, `<NETWORK>_WASM`, `<NETWORK>_ENDPOINT`.

## Caveats

- `client.dev.newBlock()` takes 1-10s. Block throughput is ~1-10 blocks/s locally, so scenarios needing many blocks (referenda confirmation, unbonding) are impractical without storage surgery.
- Use `.redact()` for volatile values or snapshots go flaky.
- Renaming or removing a test leaves obsolete snapshots: delete the `__snapshots__` entry and run `yarn test -u`.
- `await chain.pause()` to inspect state via Polkadot.js Apps (port in stdout).
