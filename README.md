# Polkadot Ecosystem Tests

Polkadot Ecosystem Tests powered by [Chopstick](http://github.com/AcalaNetwork/chopsticks).

## Run and update tests

- `yarn test` run all tests
- `yarn test:ui` run all tests with Vitest UI
- `yarn test <chain>` run tests for specific chain
- `yarn update-known-good` update [KNOWN_GOOD_BLOCK_NUMBERS.env](./KNOWN_GOOD_BLOCK_NUMBERS.env) file
- `yarn update-env` update block numbers for all chains
- `yarn test -u` update snapshots

## Notes

- By default, the tests are run against the block numbers in `KNOWN_GOOD_BLOCK_NUMBERS.env`. If you want to run the tests against the latest block numbers, you can run `yarn update-env` first.
- It is recommended to have `DB_PATH=./db.sqlite` in your `.env` file to cache the chain state in order to speed up repeated test runs.
- The tests are always running against the block numbers specified in environment variables, which are configured in both `.env` and `KNOWN_GOOD_BLOCK_NUMBERS.env`. This ensures everything are reproducible.
- Snapshots are used to compare the actual results with the expected results. The tests will fail if the snapshots different but it doesn't nessesary means something is wrong. It is possible that for example some data structure is changed due to a runtime upgrade. In such case, you can run `yarn test -u` to update the snapshots. However, always manually inspect the diffs to ensure they are expected.

## Develop new tests

### Add a new chain

Chain configurations are defined in [packages/networks/src/chains](packages/networks/src/chains). Use existing chains as examples. Make sure to update [index.ts](packages/networks/src/chains/index.ts) as well.

### Add XCM tests between two chains

The XCM tests are defined in [packages/kusama/src](packages/kusama/src) and [packages/polkadot/src](packages/polkadot/src) for Kusama chains and Polkadot chains respectively. Add a new file with name of `<chain1>.<chain2>.test.ts` for tests between those two chains. Use existing files as examples.

### Add new kind of XCM tests

The XCM tests are defined in [packages/shared/src/xcm](packages/shared/src/xcm). They are implemented in such a way that they are network agnostic and can be reused across different chains. The tests should also be tolerable to minor changes regards to onchain envoronment. For example, it should not be impacted by small change of transaction fees and should use `.redact` to round the numbers or remove fields that are constantly changing.

For network specific tests that cannot be reused, just add them as normal tests.

## Environment Variables

Environment variables can be set in `.env` file. The following variables are supported:

- `DB_PATH`: path to the cache database.
- `RUNTIME_LOG_LEVEL`: log level for the runtime. 5 for error, 4 for warn, 3 for info, 2 for debug, 1 for trace. Default is 0.
- `LOG_LEVEL`: log level for Chopstick. Note, use `yarn vitest` instead of `yarn test` to see logs. Options are `error`, `warn`, `info`, `debug`, `trace`. Default is `error`.
- `$(NETWORK_NAME)_BLOCK_NUMBER`: set block number for the chain.
- `$(NETWORK_NAME)_WASM`: path to the chain wasm file.
- `$(NETWORK_NAME)_ENDPOINT`: endpoint of the chain.

## Known Good Block Numbers

Known good block numbers are stored in `KNOWN_GOOD_BLOCK_NUMBERS.env`. Those block numbers are used by default when running tests unless they are overriden by environment variables.

The [Update Known Good Block Numbers](https://github.com/open-web3-stack/polkadot-ecosystem-tests/actions/workflows/update-known-good.yml) workflow will automatically update the known good block numbers periodically.

Use `yarn update-known-good` to update the known good block numbers manually.

Use `yarn update-env` to fetch the latest block numbers for all chains and save them to `.env` file. Note this change is ignored by git. However, it can be useful to ensure the tests are not flaky due to block number changes.

Use [Update Snapshots]](https://github.com/open-web3-stack/polkadot-ecosystem-tests/actions/workflows/update-snapshot.yml) workflow in there are some new changes breaks the tests. It will update known good block numbers and update snapshots and open an PR. Please review the update snapshots to ensure it is expected. In case of changes due to onchain fees, we will want to adjust precision in the tests to prevent flakiness in the future.
