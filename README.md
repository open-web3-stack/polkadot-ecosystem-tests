# Polkadot Ecosystem Tests

Automated testing suite for the Polkadot ecosystem powered by [Chopsticks](http://github.com/AcalaNetwork/chopsticks).

## Quick Start

```bash
# Install dependencies
yarn install

# Run all tests
yarn test

# Run tests for specific chain
yarn test <chain>

# Run specific test
yarn test -t <test-name> #<test-name> is what was passed to `vitest.test()`, usually inside a `describe()` suite

# Run with Vitest UI
yarn test:ui

# Update snapshots
yarn test -u
```

## For Network Operators

### Automated Test Runs
- Tests run every 6 hours automatically
- Failed tests are retried after 5 minutes
- Persistent failures trigger notifications
- Subscribe to [notification issues](https://github.com/open-web3-stack/polkadot-ecosystem-tests/issues?q=is%3Aissue+is%3Aopen+label%3Anotifications) for updates

### Manual Test Triggers
Use the [bot trigger issue](https://github.com/open-web3-stack/polkadot-ecosystem-tests/issues/45) to run tests on-demand via GitHub Actions

## For Test Writers

### Test Naming Convention

For XCM tests between two networks, use the naming convention

```
<chain-a>.<chain-b>.test.ts
```

For end-to-end tests on a single network, use

```
<chain-name>.<test-suite-name>.e2e.test.ts
```

#### Reason

This repository has automated test failure reporting enabled.
Each network has its own issue, to which the failing CI/CD pipeline will write a comment with the offending job.

This naming convention is necessary so the script that does all this can correctly identify the issue it must write to.

### Environment Configuration
Create `.env` file with:
```env
# Required settings
DB_PATH=./db.sqlite         # Cache database location
RUNTIME_LOG_LEVEL=3         # Log level (1=error to 5=trace)
LOG_LEVEL=info             # General logging (error/warn/info/debug/trace)

# Optional overrides
<NETWORK>_BLOCK_NUMBER=123  # Custom block number
<NETWORK>_WASM=/path/to/wasm # Custom runtime
<NETWORK>_ENDPOINT=wss://... # Custom endpoint
```

### Project Structure
- `packages/shared/src/xcm`: Common XCM test suites
- `package/shared/src/*.ts`: Common utilities for E2E tests.
- `packages/kusama/src`: Kusama network tests
- `packages/polkadot/src`: Polkadot network tests

### About end-to-end tests

This repository contains E2E tests for the Polkadot/Kusama networks.

These include:
- E2E suite for proxy accounts:
  - proxy account creation, removal
  - pure proxy account creation, removal
  - execution of proxy calls
  - test delay in proxy actions, as well as announcement/removal, and executing of announced action
  - proxy call filtering works both positively and negatively; in particular, for every proxy type in Polkadot/Kusama relay and system parachains, it is checked that:
      - a proxy of a given type can always execute calls which that proxy type is allowed to execute
      - a proxy of a given type can never execute calls that its proxy type disallowws it from running
        - see the section below for more
  - E2E suite for multisig accounts and operations
    - multisig creation, approval and execution
    - multisig cancellation, and deposit refunding
    - diverse failure modes tested (wrong timepoints, malformed execution/approval calls)
- E2E suite for vesting
  - normal (signed) and forced (root) vested transfers
  - forced (root) vesting schedule removal
  - merger of vesting schedules
- E2E suite for nomination pools:
  - Creating a pool, joining it, bonding extra
  - Setting a pool's state, metadata, roles and commission data
  - Scenario checking an account can be at most in one pool
- E2E suite for governance infrastructure - referenda, preimages, and conviction voting. It includes
  - Creating a referendum for a treasury proposal, voting on it (with conviction/split/abstain)
  - Cancelling and killing referenda with XCM root-originated calls
  - Noting and unnoting preimages
- E2E suite for staking infrastructure:
  - bonding funds, declaring intent to nominate/validate, unbonding, chilling, forcibly unstaking as `Root`
    - includes a test to fast unstaking
  - changing global staking configs - minimum nom./val. bonds, val. commissions, nom./val. counts, etc.
  - more complex scenarios:
    - forcefully updating a validator's commission after an increase to the global parameters' commission
    - chilling other participants in the system, only when the conditions for doing so are met
- E2E suite for the task scheduling mechanism provided by the `scheduler` pallet
  - schedule tasks, named or otherwise
  - cancel scheduled tasks
- E2E test suite to the people chains in both networks. This suite contains scenarios such as
  - Adding, modifying, and removing identities
  - Requesting judgement requests on registrars, and providing it
  - Adding registrars to the people chain by sending, from the relay chain, an XCM call with root origin
  - Adding, modifying, and removing subidentities for an account

The intent behind these end-to-end tests is to cover the basic behavior of relay chains' and system
parachains' runtimes.

Initial coverage can be limited to critical path scenarios composed of common extrinsics
from each of a runtime's pallets, and from there test more complex interactions.

Note that since block execution throughput in `chopsticks` on a local development machine is limited
to roughly `1-10` blocks/second, not all scenarios are testable in practice e.g. referenda
confirmation, or the unbonding of staked funds.
Consider placing such tests elsewhere, or using different tools (e.g. XCM emulator).

#### Proxy call filtering checker

The proxy E2E test suite contains checks to proxy types' allowed and disallowed calls - for many chains.
Because these tests are extensive and hard to manually verify (the test code itself and the snapshots), there exists a
coverage checking script (`scripts/check-proxy-coverage.ts`)
It searches for allowed/forbidden call coverage for a chain's proxy types.

Run it with `yarn check-proxy-coverage` to see which proxy types need test coverage.

### Test Guidelines
- Write network-agnostic tests where possible
- Handle minor chain state changes gracefully
- Use `.redact()` for volatile values
  - Pass `{ number: n }` to `.redact()` to explicitly redact all but the `n` most significant digits
  - Pass `{ removeKeys: new RegExp(s) }` to remove keys from an object that are unwanted when e.g.
    using `toMatchObject/toMatchSnapshot`. `s` can contain several fields e.g.
    `"alarm|index|submitted"`. Check [this page](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp) for how to use `RegExp`.
- Leverage snapshots for easier maintenance
- Follow naming convention: `<chain1>.<chain2>.test.ts` or `<chain1>.test.ts`

### Adding New Chains
1. Add chain configuration in `packages/networks/src/chains/`
2. Update chain index in `packages/networks/src/chains/index.ts`
3. Create notification issue
4. Update `.github/workflows/notifications.json`

### Adding new E2E tests
1. Create a file in `packages/shared/src/` with the E2E tests, and their required utilities
  - This assumes that the E2E test will run on Polkadot/Kusama: its code being shared makes it
    reusable on both chains
2. Using the shared utilities created in the previous step, create Polkadot/Kusama tests in
  `packages/polkadot/src`/`packages/kusama/src`, respectively.
3. Run the newly created tests so their snapshots can be created in `packages/<network>/src/__snapshots__`
  - Inspect the snapshots, and make corrections to tests as necessary - or upstream, if the test
    has revealed an issue with e.g. `polkadot-sdk`
4. Create a PR with the new tests.

### Writing Tests

#### Test Structure

Tests are organized using Vitest and follow this general structure:

```typescript
import { coretimePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { sendTransaction } from '@acala-network/chopsticks-testing'
import { check, checkEvents, checkSystemEvents } from '../helpers/index.js'

describe('chain.otherChain', () => {
  // Create network instance before tests
  const [polkadotClient, coretimeClient] = await setupNetworks(polkadot, coretimePolkadot)

  it('should transfer tokens', async () => {
    // Test implementation
    const tx = await sendTransaction(polkadotClient.api.tx.xcmPallet.teleportAssets( /* args */ ))

    // Assertions using snapshots
    await checkEvents(result).toMatchSnapshot('teleportAssets events');
  })
})
```

#### Key Testing Patterns

1. **Network Setup**
```typescript
// Create chain clients
const [polkadotClient, coretimeClient] = await setupNetworks(polkadot, coretimePolkadot)
```

2. **Snapshot Testing**
```typescript
// Redact volatile values
await check(result).redact().toMatchSnapshot();

// Redact specific digits
check(result.redact({ number: 1 })).toMatchSnapshot();

// Remove specific keys
check(result.redact({
  removeKeys: /(timestamp|blockHash)/
})).toMatchSnapshot();
```

3. **Executing extrinsics with a given origin**
Use `scheduleCallWithOrigin` on chains whose runtime includes `pallet-scheduler` to be able to execute
permission-restricted extrinsics with the appropriate origin e.g. `Root`-gated global parameter controls
for staking and nomination pools

4. **Send XCM `Transact`s to execute extrinsics with given origin in parachain**
In parachains where `pallet-scheduler` is not available, but whose relay chain has it, use `createXcmTransactSend` 
along with `scheduleCallWithOrigin` to prepare and schedule sending of an XCM to perform the technique in 3. in the desired parachain.

    4.1. Take care to adjust the parameters in accordance with the destination parachain, in particular
         `refTime/proofSize`

Read [here](https://github.com/AcalaNetwork/chopsticks?tab=readme-ov-file#testing-with-acala-networkchopsticks-testing) for more about `@acala-network/chopsticks-testing`


#### Best Practices

1. **Network-Agnostic Testing**
   - Write shared test suites in `packages/shared/src/`
   - Implement chain-specific tests in respective packages
   - Use parameterized tests for multi-chain scenarios

2. **Snapshot Testing**
   - Prefer snapshots over manual assertions
   - Redact volatile values to prevent flaky tests
   - Review snapshot changes carefully
   - Keep snapshots focused and readable
   - Update snapshots when behavior changes intentionally

3. **Error Handling**
   - Test both success and failure cases
   - Verify error messages and types
   - Handle chain-specific error scenarios

### Regenerate Snapshots

It is recommended to regenerate snapshots when renaming or removing tests. This can be done by deleting `__snapshots__` folders and running `yarn test -u`.

### Debugging Tips
- Use `{ only: true }` to isolate tests
- Add logging to shared test suites
- Insert `await chain.pause()` for state inspection
- Connect via Polkadot.js Apps to paused chains
  - Check the logs of the terminal running the `.pause`d test for the address and port
- Try to reproduce unexpected test result in a standalone Chopsticks instance
- Carefully review snapshot changes

### Block Number Management
```bash
# Update KNOWN_GOOD_BLOCK_NUMBERS.env to latest
yarn update-known-good

# Update .env to latest (CI always uses KNOWN_GOOD_BLOCK_NUMBERS.env)
yarn update-env
```

## For Maintainers

### Bot Commands
- `/bot update` - Update snapshots
- `/bot merge` - Approve and enable auto-merge
- `/bot cancel-merge` - Disable auto-merge

Authorized users are defined in `.github/command-runner/command-runner-config.json`
