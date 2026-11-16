import {describe,it,expect,vi} from 'vitest';
import {parseAbi,parseEther,parseUnits,zeroAddress,type Address} from 'viem';
import {configureProtocolFee} from '../src/fees.js';
import {erc20,factoryAbi,pairAbi,routerAbi} from '../src/shared.js';
import {fixture} from './fixture.js';

const admin='0x0000000000000000000000000000000000000001' as Address;
const treasury='0x0000000000000000000000000000000000000002' as Address;
const stranger='0x0000000000000000000000000000000000000003' as Address;
function config(current:Address=zeroAddress,authority:Address=admin){
 let recipient=current;
 return {treasury,admin,readRecipient:vi.fn(async()=>recipient),readAdmin:vi.fn(async()=>authority),setRecipient:vi.fn(async(value:Address)=>{recipient=value})};
}
describe('protocol fee setup',()=>{
 it('enables the treasury and verifies it, and resumes without another write',async()=>{const x=config();await configureProtocolFee(x);await configureProtocolFee(x);expect(x.setRecipient).toHaveBeenCalledExactlyOnceWith(treasury);expect(x.readRecipient).toHaveBeenCalledTimes(3)});
 it('rejects a zero treasury',async()=>{const x={...config(),treasury:zeroAddress};await expect(configureProtocolFee(x)).rejects.toThrow('cannot be zero');expect(x.setRecipient).not.toHaveBeenCalled()});
 it('does not overwrite another nonzero recipient',async()=>{const x=config(stranger);await expect(configureProtocolFee(x)).rejects.toThrow('Unexpected');expect(x.setRecipient).not.toHaveBeenCalled()});
 it('refuses the wrong administrator',async()=>{const x=config(zeroAddress,stranger);await expect(configureProtocolFee(x)).rejects.toThrow('administrator');expect(x.setRecipient).not.toHaveBeenCalled()});
 it('requires the recipient to match after a successful write',async()=>{const x={...config(),setRecipient:vi.fn(async()=>{})};await expect(configureProtocolFee(x)).rejects.toThrow('not confirmed')});
});

const accounting=parseAbi(['function totalSupply() view returns (uint256)','function kLast() view returns (uint256)','function removeLiquidityETH(address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)']);
function sqrt(n:bigint){if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n}return x}
async function trade(x:Awaited<ReturnType<typeof fixture>>){
 const input=parseEther('.1');
 const reserves=await x.client.readContract({address:x.p,abi:pairAbi,functionName:'getReserves'});
 const token0=await x.client.readContract({address:x.p,abi:pairAbi,functionName:'token0'});
 const [reserveIn,reserveOut]=token0.toLowerCase()===x.w.toLowerCase()?reserves:[reserves[1],reserves[0]];
 const amounts=await x.client.readContract({address:x.r,abi:routerAbi,functionName:'getAmountsOut',args:[input,[x.w,x.token]]});
 // Fee-on must not add a second trader charge: the normal 997 / 1000 formula still applies.
 expect(amounts[1]).toBe(input*997n*reserveOut/(reserveIn*1000n+input*997n));
 await x.write(x.r,routerAbi,'swapExactETHForTokens',[amounts[1],[x.w,x.token],x.other,x.deadline],input);
}
async function add(x:Awaited<ReturnType<typeof fixture>>){
 await x.write(x.r,routerAbi,'addLiquidityETH',[x.token,parseUnits('100',6),0n,0n,x.owner,x.deadline],parseEther('.1'));
}
describe('upstream V2 protocol fees on a disposable local EVM',()=>{
 it('accrues the exact treasury LP share and allows its owner to redeem both assets',async()=>{
  const x=await fixture();try{
   expect((await x.client.readContract({address:x.f,abi:factoryAbi,functionName:'feeTo'})).toLowerCase()).toBe(x.treasury.toLowerCase());
   const lp=()=>x.client.readContract({address:x.p,abi:erc20,functionName:'balanceOf',args:[x.treasury]});
   expect(await lp()).toBe(0n);
   const kLast=await x.client.readContract({address:x.p,abi:accounting,functionName:'kLast'});expect(kLast).toBeGreaterThan(0n);
   await trade(x);expect(await lp()).toBe(0n); // Collection happens on the next mint/burn, not the swap itself.
   const reserves=await x.client.readContract({address:x.p,abi:pairAbi,functionName:'getReserves'});
   const supply=await x.client.readContract({address:x.p,abi:accounting,functionName:'totalSupply'});
   const rootK=sqrt(reserves[0]*reserves[1]),rootLast=sqrt(kLast);
   const expected=supply*(rootK-rootLast)/(rootK*5n+rootLast);expect(expected).toBeGreaterThan(0n);
   await add(x);expect(await lp()).toBe(expected);
   await x.write(x.p,erc20,'approve',[x.r,expected],0n,x.treasury);
   const before=await x.client.readContract({address:x.token,abi:erc20,functionName:'balanceOf',args:[x.other]});
   const nativeBefore=await x.client.getBalance({address:x.other});
   await x.write(x.r,accounting,'removeLiquidityETH',[x.token,expected,1n,1n,x.other,x.deadline],0n,x.treasury);
   expect(await lp()).toBe(0n);
   expect(await x.client.getBalance({address:x.other})).toBeGreaterThan(nativeBefore);
   expect(await x.client.readContract({address:x.token,abi:erc20,functionName:'balanceOf',args:[x.other]})).toBeGreaterThan(before);
  }finally{await x.close()}
 },60000);
 it('rejects a normal user redirecting the protocol fee',async()=>{
  const x=await fixture();try{
   await expect(x.client.simulateContract({account:x.other,address:x.f,abi:factoryAbi,functionName:'setFeeTo',args:[x.other]})).rejects.toThrow();
   expect((await x.client.readContract({address:x.f,abi:factoryAbi,functionName:'feeTo'})).toLowerCase()).toBe(x.treasury.toLowerCase());
  }finally{await x.close()}
 },60000);
 it('does not mint treasury LP tokens when the fee switch is off',async()=>{
  const x=await fixture(false);try{await trade(x);await add(x);expect(await x.client.readContract({address:x.p,abi:erc20,functionName:'balanceOf',args:[x.treasury]})).toBe(0n);expect(await x.client.readContract({address:x.p,abi:accounting,functionName:'kLast'})).toBe(0n)}finally{await x.close()}
 },60000);
});
