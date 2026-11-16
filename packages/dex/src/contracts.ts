import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import solc from 'solc';
import { keccak256, type Abi, type Hex } from 'viem';
const require = createRequire(import.meta.url);
export interface Artifact { abi: Abi; bytecode: Hex }
function upstream(path: string): Artifact {
  const a = JSON.parse(readFileSync(require.resolve(path), 'utf8'));
  return { abi: a.abi, bytecode: `0x${a.bytecode.replace(/^0x/, '')}` };
}
export const factory = upstream('@uniswap/v2-core/build/UniswapV2Factory.json');
export const pair = upstream('@uniswap/v2-core/build/UniswapV2Pair.json');
export const router = upstream('@uniswap/v2-periphery/build/UniswapV2Router02.json');
export const pairInitCodeHash = keccak256(pair.bytecode);
export const ROUTER_PAIR_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
export function assertPairHash() {
  if (pairInitCodeHash !== ROUTER_PAIR_HASH) throw new Error('Pair bytecode does not match the router CREATE2 hash');
  if (!router.bytecode.includes(ROUTER_PAIR_HASH.slice(2))) throw new Error('Router artifact lacks the expected pair hash');
}
export function compile(file: URL, name: string): Artifact {
  const input = { language:'Solidity', sources:{'Contract.sol':{content:readFileSync(file,'utf8')}}, settings:{evmVersion:'paris',optimizer:{enabled:true,runs:200},metadata:{bytecodeHash:'none'},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}} };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: {severity:string}) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e:{formattedMessage:string}) => e.formattedMessage).join('\n'));
  const c = out.contracts['Contract.sol'][name];
  return {abi:c.abi,bytecode:`0x${c.evm.bytecode.object}`};
}
export const wrapped = () => compile(new URL('../contracts/WrappedTestSYS.sol', import.meta.url), 'WrappedTestSYS');
// Used only on the disposable local EVM. Live deployment reuses the existing tokens.
// A copy of zksys-spike's TestUSD.sol (identical), so the DEX tests do not depend on the experiment package.
export const localTestUSD = () => compile(new URL('../contracts/TestUSD.sol', import.meta.url), 'TestUSD');
