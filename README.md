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
- `packages/kusama/src`: Kusama network tests
- `packages/polkadot/src`: Polkadot network tests

### Test Guidelines
- Write network-agnostic tests where possible
- Handle minor chain state changes gracefully
- Use `.redact()` for volatile values
- Leverage snapshots for easier maintenance
- Follow naming convention: `<chain1>.<chain2>.test.ts` or `<chain1>.test.ts`

### Adding New Chains
1. Add chain configuration in `packages/networks/src/chains/`
2. Update chain index in `packages/networks/src/chains/index.ts`
3. Create notification issue
4. Update `.github/workflows/notifications.json`

### Debugging Tips
- Use `{ only: true }` to isolate tests
- Add logging to shared test suites
- Insert `await chain.pause()` for state inspection
- Connect via Polkadot.js Apps to paused chains
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
