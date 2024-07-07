# Polkadot Ecosystem Tests

Polkadot Ecosystem Tests powered by [Chopstick](http://github.com/AcalaNetwork/chopsticks).

## Run and update tests

- `yarn test` run all tests
- `yarn test:ui` run all tests with Vitest UI
- `yarn test <chain>` run tests for specific chain
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

The XCM tests are defined in [packages/shared/src/xcm](packages/shared/src/xcm). They are implemented in such a way that they are network agnostic and can be reused across different chains. The tests should also be tolerable to minor changes regards to onchain envoronment. For example, it should not be impacted by small change of transaction fees and should use `.reduct` to round the numbers or remove fields that are constantly changing.
