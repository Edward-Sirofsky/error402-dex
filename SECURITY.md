# Security

This project runs on the zkSYS **testnet** with test assets only. It has had an internal review and fixes, but no
independent audit, and must not be used with real funds.

## Reporting a problem

Please use GitHub's private vulnerability reporting for this repository (Security → Report a vulnerability) rather
than a public issue. Include the commit, steps to reproduce and the impact you expect. There is no bug bounty.

## Design in brief

- Contracts: Uniswap V2 Factory, Pair and Router02, deployed unchanged from the published npm artifacts, plus a
  minimal wrapped native token (`WrappedTestSYS.sol`). The protocol fee is Uniswap V2's `feeTo` (one sixth of the
  0.30% LP fee). Admin roles and recipients can be read on-chain from the addresses in the README.
- Website: it acts only on the zkSYS testnet (chain ID 57057). The wallet's network and account are checked before
  every simulation and again immediately before the wallet is asked to send; any other network is refused. Every wallet
  request is recorded in browser storage **before** the wallet opens; trading stays locked until the outcome is certain
  from chain data. Nothing is ever resubmitted automatically. Swaps send the "Minimum received" shown on screen, which
  price refreshes never lower; withdrawals send the minimums shown on screen, computed from figures read at one block.

## Issues found and fixed in the internal review (November 2026)

- A wallet request with an uncertain outcome could leave trading locked forever, or unlocked while still pending.
  Now: structured lock, recovery from chain data, and "expired" only when the latest block's timestamp is past the
  router deadline (the local clock is never used).
- A transaction cancelled or replaced in the wallet could be reported as a successful swap. Now detected and reported.
- Recovery could take an earlier identical approval for the current one. Now only transactions at or after the nonce
  recorded for the request are considered.
- The displayed 0.50% slippage could, after price drift, really be close to 0%. The tolerance shown is now the room
  actually left, and below 0.10% the user must accept the current price.
- Background polling could run during a wallet request or in a hidden tab. Every start now checks the pause.
- Two tabs could open two wallet requests at the same instant. A Web Lock now makes this exclusive.
- Also: data-freshness labels, UTC trade times, decimal-comma input, chart attribution clipping, HSTS header.

## Issues found and fixed after the second independent review (November 2026)

An independent review of `beta-0.2.0` confirmed the release provenance (rebuild, served files, deployed bytecode) and
found no Critical or High contract issue. It reproduced two website issues and raised four transaction-handling
concerns; all six are fixed in `beta-0.3.0`, each with regression tests (`review-2-regressions.test.ts`).

- **E402-01 (Medium):** pool figures were read without pinning them to one block, so old reserves could be combined
  with a newer LP supply and halve the withdrawal minimum. Every pool figure is now read at one block, the minimums
  shown are the ones sent, and a fresh read at the click must still cover them.
- **E402-02 (Low):** after switching wallets, the previous wallet's LP amount could be used. The position is now tied
  to the account it was read for and is not shown or usable for another account.
- **TX-01:** a wallet disconnect (4900/4901) or "resource unavailable" (-32002) was taken as proof that nothing was
  sent. After the wallet's send method has been called, these now keep the request locked until chain data settles it.
- **TX-02:** viem can retry a failed `eth_sendTransaction` as `wallet_sendTransaction`. The page now lets one request
  reach the wallet's send method at most once, and the first error decides the outcome.
- **TX-03:** the stored request records share one storage key; writes from two tabs could interleave. Every write
  (including recovery results, "stop tracking" and migration of old data) now runs under one site-wide Web Lock.
- **TX-04:** an approval found only by spender and a nonce lower bound could be an earlier approval that was still
  pending. Such a match is now shown as a *possible* match and the request stays tracked; it is never reported as
  this request's confirmation.

## Tokens the pools trade against

The DEX contracts are immutable; the existing tokens are not.

- **ZKSYS** (`0x6EBb…C35d`) is an EIP-1967 transparent proxy (implementation `0x95c5…870e`, proxy admin
  `0xabb7…8ac8` at the time of writing). Its administrator can change the implementation, and the reviewed
  implementation has mint and burn roles; a burn from a pool address would change the pool's balance relative to its
  recorded reserves. Treat ZKSYS behaviour as controlled by its administrators.
- **tUSD** (`0x2334…7793`) has no verified source on the explorer. `TestUSD.sol` in this repository is a local test
  stand-in, not the deployed token.

## Known limitations

- Real Pali and MetaMask behaviour (error codes, cancel and speed-up, mobile in-app browsers) has been tested only
  with simulated wallets.
- The page's React wiring has a first-render test only; interaction paths are exercised through the modules it uses.
- Cross-tab storage locking is tested with Node's Web Locks and simulated storage, not across real browser processes.
- Where the browser has no Web Locks API, cross-tab protection falls back to re-reading storage.
- Expiry is decided from the latest block without a confirmation-depth rule.
- The public RPC is used for all reads (about 50–70 requests per visible tab per minute).
- `npm audit` reports no known vulnerabilities (17 November 2026). Tests use Hardhat's in-process EVM with its usage
  analytics switched off, so running them contacts no server.
