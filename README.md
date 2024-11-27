# Polkadot Ecosystem Tests

Polkadot Ecosystem Tests powered by [Chopsticks](http://github.com/AcalaNetwork/chopsticks).

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
- The tests are always running against the block numbers specified in environment variables, which are configured in both `.env` and `KNOWN_GOOD_BLOCK_NUMBERS.env`. This ensures everything is reproducible.
- Snapshots are used to compare the actual results with the expected results. The tests will fail if the snapshots are different, but it doesn't necessarily mean something is wrong. It is possible, for example, that some data structure has changed due to a runtime upgrade. In such cases, you can run `yarn test -u` to update the snapshots. However, always manually inspect the diffs to ensure they are expected.

## Trigger remote test runs

Use the [bot trigger issue](https://github.com/open-web3-stack/polkadot-ecosystem-tests/issues/45) to trigger test runs on GH Actions.

## Merge PR

Use `/bot merge` command in a comment to approve and enable auto-merge of a PR. Use `/bot cancel-merge` to cancel the auto-merge.

The user have to be authorized in the [command-runner-config.json](./.github/command-runner/command-runner-config.json) file to use the commands.

## Develop new tests

### Add a new chain

Chain configurations are defined in [packages/networks/src/chains](packages/networks/src/chains). Use existing chains as examples. Make sure to update [index.ts](packages/networks/src/chains/index.ts) as well.

To setup the notifications, create a new notification issue and add the issue number to [notifications.json](./.github/workflows/notifications.json).

### Add XCM tests between two chains

The XCM tests are defined in [packages/kusama/src](packages/kusama/src) and [packages/polkadot/src](packages/polkadot/src) for Kusama chains and Polkadot chains respectively.
Add a new file named of `<chain1>.<chain2>.test.ts` for tests between those two chains. Use existing files as examples.

### Add new kind of XCM tests

The XCM tests are defined in [packages/shared/src/xcm](packages/shared/src/xcm). They are implemented in such a way that they are network agnostic and can be reused across different chains. The tests should also be tolerant to minor changes regarding onchain envoronment. For example, they should not be impacted by a small change in transaction fees, and should use `.redact` to round the numbers or remove fields that are constantly changing.

For network specific tests that cannot be reused, just add them as normal tests.

### Debug tests

- Add `{ only: true }` as a testcase last parameter to run only that test
- Modify the shared test to add more logs or add more info to the snapshots
- Use `await chain.pause()` to pause the test. Check the logs for the RPC URL and use pjs apps to connect to it for debugging.

## Environment Variables

Environment variables can be set in `.env` file. The following variables are supported:

- `DB_PATH`: path to the cache database.
- `RUNTIME_LOG_LEVEL`: log level for the runtime. 1 for error, 2 for warn, 3 for info, 4 for debug, 5 for trace. Default is 0.
- `LOG_LEVEL`: log level for Chopstick. Note, use `yarn vitest` instead of `yarn test` to see logs. Options are `error`, `warn`, `info`, `debug`, `trace`. Default is `error`.
- `$(NETWORK_NAME)_BLOCK_NUMBER`: set block number for the chain.
- `$(NETWORK_NAME)_WASM`: path to the chain's wasm file.
- `$(NETWORK_NAME)_ENDPOINT`: endpoint of the chain.

## Known Good Block Numbers

Known good block numbers are stored in `KNOWN_GOOD_BLOCK_NUMBERS.env`. Those block numbers are used by default when running tests unless they are overriden by environment variables.

The [Update Known Good Block Numbers](https://github.com/open-web3-stack/polkadot-ecosystem-tests/actions/workflows/update-known-good.yml) workflow will automatically update the known good block numbers periodically.

Use `yarn update-known-good` to update the known good block numbers manually.

Use `yarn update-env` to fetch the latest block numbers for all chains and save them to `.env` file. Note this change is ignored by git. However, it can be useful to ensure the tests are not flaky due to block number changes.

Use [Update Snapshots](https://github.com/open-web3-stack/polkadot-ecosystem-tests/actions/workflows/update-snapshot.yml) workflow if there are some new changes breaks the tests.
It will update known good block numbers, update snapshots, and open an PR. Please review the update snapshots to ensure it is expected.
In case of changes due to onchain fees, we will want to adjust precision in the tests to prevent flakiness in the future.
