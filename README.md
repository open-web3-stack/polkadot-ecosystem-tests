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
- E2E test suite to the people chains in both networks. This suite contains scenarios such as
  - Adding, modifying, and removing identities
  - Requesting judgement requests on registrars, and providing it
  - Adding registrars to the people chain by sending, from the relay chain, an XCM call with root origin
  - Adding, modifying, and removing subidentities for an account
- E2E suite for governance infrastructure - referenda, preimages, and conviction voting. It includes
  - Creating a referendum for a treasury proposal, voting on it
  - Cancelling and killing referenda with XCM root-originated calls
  - Noting and unnoting preimages

The intent behind these end-to-end tests is to cover the basic behavior of relay chains' and system
parachains' runtimes.

Initial coverage can be limited to critical path scenarios composed of common extrinsics
from each of a runtime's pallets, and from there test more complex interactions.

Note that since block execution throughput in `chopsticks` on a local development machine is limited
to roughly `1` and `10` blocks/second, not all scenarios are testable in practice e.g. referenda
confirmation, or the unbonding of staked funds.
Consider placing such tests elsewhere, or using different tools (e.g. XCM emulator).

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
4. Craete a PR with the new tests.

### Regenerate Snapshots

It is recommended to regenerate snapshots when renaming or removing tests. This can be done by deleting `__snapshots__` folders and running `yarn test -u`.

### Debugging Tips
- Use `{ only: true }` to isolate tests
- Add logging to shared test suites
- Insert `await chain.pause()` for state inspection
- Connect via Polkadot.js Apps to paused chains
  - Check the logs of the terminal running the `.pause`d test for the address and port
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
