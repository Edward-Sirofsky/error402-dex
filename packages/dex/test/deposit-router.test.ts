// The website's deposit check (wallet-check/src/deposit.ts) against the real Uniswap V2 router on Hardhat's
// in-process EVM (no network): what it refuses really fails with TRANSFER_FROM_FAILED, what it suggests succeeds.
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {parseAbi,parseEther,parseUnits,maxUint256} from 'viem';
import {checkDeposit} from '../../wallet-check/src/deposit.js';
import {fixture} from './fixture.js';
import {erc20,pairAbi} from '../src/shared.js';
describe('against the real Uniswap V2 router',()=>{
 let x:Awaited<ReturnType<typeof fixture>>;
 beforeAll(async()=>{x=await fixture()},60000);afterAll(async()=>{await x?.close()});
 it('what checkDeposit refuses really fails with TRANSFER_FROM_FAILED, and the amount it suggests really succeeds',async()=>{
  const add=parseAbi(['function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)']);
  await x.write(x.token,erc20,'mint',[x.other,parseUnits('5',6)]);
  await x.write(x.token,erc20,'approve',[x.r,maxUint256],0n,x.other);
  const [r0,r1]=await x.client.readContract({address:x.p,abi:pairAbi,functionName:'getReserves'});
  const nativeFirst=(await x.client.readContract({address:x.p,abi:pairAbi,functionName:'token0'})).toLowerCase()===x.w.toLowerCase();
  const live={native:nativeFirst?r0:r1,token:nativeFirst?r1:r0};
  const have={native:await x.client.getBalance({address:x.other}),token:parseUnits('5',6)};
  const tooMuch=parseEther('0.01'),tokenFor=(n:bigint)=>n*live.token/live.native;
  let message='';try{checkDeposit(live,tooMuch,tokenFor(tooMuch),have,6,'tUSD')}catch(e){message=(e as Error).message}
  expect(message).toMatch(/your wallet has 5 tUSD/);
  const suggested=parseEther(/up to about ([\d.]+) TSYS/.exec(message)?.[1]??'0');expect(suggested).toBeGreaterThan(0n);
  await expect(x.client.simulateContract({account:x.other,address:x.r,abi:add,functionName:'addLiquidityETH',value:tooMuch,args:[x.token,tokenFor(tooMuch),tokenFor(tooMuch)*995n/1000n,tooMuch*995n/1000n,x.other,x.deadline]})).rejects.toThrow(/TRANSFER_FROM_FAILED/);
  expect(()=>checkDeposit(live,suggested,tokenFor(suggested),have,6,'tUSD')).not.toThrow();
  await expect(x.client.simulateContract({account:x.other,address:x.r,abi:add,functionName:'addLiquidityETH',value:suggested,args:[x.token,tokenFor(suggested),tokenFor(suggested)*995n/1000n,suggested*995n/1000n,x.other,x.deadline]})).resolves.toBeTruthy();
 },60000);
});
