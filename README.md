# error402 DEX — zkSYS testnet

A spot DEX on the zkSYS testnet (chain ID 57057): unmodified Uniswap V2 contracts, a wrapped native test token, and
the trading website served at the public beta. **Testnet only. Test assets only. Not audited for mainnet use.**

## What is in this repository

| Path | Contents |
|---|---|
| `packages/dex` | Contract artifacts and compilation (`src/contracts.ts`), protocol-fee configuration (`src/fees.ts`), shared chain/ABI constants (`src/shared.ts`), `WrappedTestSYS.sol`, the local test token `TestUSD.sol`, the testnet deployment record, and tests that deploy everything on a local in-process EVM (Hardhat's EDR) |
| `packages/dex/deployments/zksys-testnet.json` | Addresses and transaction hashes of the live testnet deployment |
| `packages/wallet-check` | The website (React + viem): swaps with automatic quotes, liquidity, price chart, transaction-status recovery |
| `licenses/` | Licences of third-party components (see `THIRD_PARTY_NOTICES.md`) |

The Factory, Pair and Router02 are the published Uniswap V2 build artifacts, loaded unchanged from
`@uniswap/v2-core` 1.0.1 and `@uniswap/v2-periphery` 1.1.0-beta.0; `assertPairHash()` checks that the router's
built-in pair hash matches the pair bytecode.

Not included: the operator scripts that sign live testnet transactions and any key material. The deployment can be
verified independently on the explorer from the addresses below.

## Requirements

- Node.js 22 or newer (developed with Node 24) and npm.
- No wallet, key, account or environment variable is needed to install, test or build.

## Install, test, build

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

- `npm test` runs every test in `packages/*/test`. The DEX tests compile `WrappedTestSYS.sol` and `TestUSD.sol` with
  solc 0.8.28 and deploy the Uniswap V2 artifacts on Hardhat's in-process EVM with chain ID 57057 and Hardhat's public
  test accounts; nothing touches a network (Hardhat's usage analytics are switched off in the test fixture).
  Website tests use simulated wallets and a simulated chain.
- `npm run build` writes the website to `packages/wallet-check/dist/`.
- `npm run dev` serves the website at http://127.0.0.1:4020 (it reads the live testnet through the public RPC;
  connecting Pali or MetaMask is optional).
- `npm run demo` runs a scripted swap on the local in-memory EVM.

## Live testnet deployment

| Contract | Address |
|---|---|
| UniswapV2Router02 | `0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff` |
| UniswapV2Factory | `0x06a9d6b2c3e9fa11a77ce80bfb35406525ddd022` |
| WrappedTestSYS (WTSYS) | `0xed563f8c2fbef9b6e95b0dce4f85f9b5787804e9` |
| Pair TSYS / ZKSYS | `0xdA55024740502eEDAF9b10f33bEd4eB562C3E8ba` |
| Pair TSYS / tUSD | `0xB8ED4ee2938Fe9cFa4268A3A23dE7733B912eeaB` |
| Protocol-fee recipient | `0xabFD88449fD3D789c578A66Af5A64a239253572B` |
| ZKSYS (existing token) | `0x6EBb170f69D886916D9ee9E585CE39E626CbC35d` |
| tUSD (existing test token) | `0x233440C6155E0aD350Ebcf33013BC9b52aD37793` |

RPC `https://rpc-zk.tanenbaum.io` · explorer `https://explorer-zk.tanenbaum.io`. Trading fee 0.30% per pool, of
which 0.05% goes to the protocol through Uniswap V2's `feeTo` mechanism.

## Where to look when reviewing

- `packages/wallet-check/src/tx-lock.ts` — the persisted lock around every wallet request and `recover()`, which
  settles interrupted requests from read-only chain data (cancel, speed-up, replacement, expiry by block time).
- `packages/wallet-check/src/wallet.ts` — network checks, sending (one call of the wallet's send method per request),
  wallet-error classification, replacement handling, amount parsing.
- `packages/wallet-check/src/position.ts` — pool and position figures read at one block, and the withdrawal minimums.
- `packages/wallet-check/src/quote-flow.ts` and `SwapDetails.tsx` — slippage floor and what is displayed versus sent.
- `packages/wallet-check/src/refresh.ts` and `market.ts` — polling, ordering and chart history.
- `packages/dex/src/fees.ts`, `contracts.ts` and `test/` — fee configuration and the local end-to-end tests.

See `SECURITY.md` for known limitations and how to report a problem.

## Deployments

There is one website package. The public beta (beta.error402.io) and the future main site are separate
deployments of builds from this repository (`npm run build` → `packages/wallet-check/dist/`), not separate code
folders.

## Licence

- Original code and documentation: MIT, see `LICENSE`.
- The error402 name and logo, and the brand asset files listed in `TRADEMARKS.md`, are **not** covered by MIT.
- Third-party components keep their own licences and notices: see `THIRD_PARTY_NOTICES.md` and `licenses/`. The
  Uniswap V2 contracts used by this project are GPL-3.0-or-later.
