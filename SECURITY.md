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
- Website: every wallet request is recorded in browser storage **before** the wallet opens; trading stays locked until
  the outcome is certain from chain data. Nothing is ever resubmitted automatically. Swaps send the "Minimum received"
  shown on screen, which price refreshes never lower.

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

## Known limitations

- Real Pali and MetaMask behaviour (error codes, cancel and speed-up, mobile in-app browsers) has been tested only
  with simulated wallets.
- The page's React wiring has a first-render test only; interaction paths are exercised through the modules it uses.
- Where the browser has no Web Locks API, cross-tab protection falls back to re-reading storage.
- Expiry is decided from the latest block without a confirmation-depth rule.
- The public RPC is used for all reads (about 50–70 requests per visible tab per minute).
- Development-only tools (for example Ganache) have published advisories; they are not part of the website.
