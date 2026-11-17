# Third-party components

Each component keeps its own licence. Versions are pinned in `package-lock.json`.

## Smart contracts (deployed on the testnet)

- **Uniswap V2 core** (`@uniswap/v2-core` 1.0.1) — GPL-3.0-or-later. https://github.com/Uniswap/v2-core.
  The `UniswapV2Factory` and `UniswapV2Pair` build artifacts are used and deployed unchanged.
  Licence: `licenses/uniswap-v2-core-GPL-3.0.txt`.
- **Uniswap V2 periphery** (`@uniswap/v2-periphery` 1.1.0-beta.0) — GPL-3.0-or-later.
  https://github.com/Uniswap/v2-periphery. The `UniswapV2Router02` build artifact is used and deployed unchanged.
  Licence: `licenses/uniswap-v2-periphery-GPL-3.0.txt`.

The corresponding source for these deployed contracts is the upstream source at the versions above.

## Website (bundled into the built site)

- React and react-dom 19.3.1 — MIT. viem 2.57.16 and its dependencies — MIT.
- TradingView Lightweight Charts™ 5.3.0 — Apache-2.0, with its NOTICE and attribution.
  https://github.com/tradingview/lightweight-charts. The chart keeps the library's attribution link and logo.
  TradingView Lightweight Charts™ — Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/

Full texts shipped with the site: `packages/wallet-check/public/DEPENDENCY_LICENSES.txt` and
`lightweight-charts-LICENSE.txt`.

## Development and test tools (not distributed with the site)

solc 0.8.28 (npm wrapper MIT; the bundled Solidity compiler is GPL-3.0), Hardhat 3.22.0 and its EDR runtime (MIT), Vite, Vitest,
TypeScript and tsx. Their transitive dependencies carry their own licences (MIT, ISC, Apache-2.0, BSD, MPL-2.0 and
others), as recorded in `package-lock.json`.
