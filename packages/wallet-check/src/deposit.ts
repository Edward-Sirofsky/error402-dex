import {formatUnits} from 'viem';
/** What addLiquidityETH will actually take at the pool's ratio (Uniswap V2 uses the optimal amount of one side). */
export function depositNeeds(pool:{native:bigint;token:bigint},native:bigint,token:bigint){
 if(pool.native===0n||pool.token===0n)return {native,token};
 const tokenOptimal=native*pool.token/pool.native;
 return tokenOptimal<=token?{native,token:tokenOptimal}:{native:token*pool.native/pool.token,token};
}
const show=(n:bigint,decimals:number)=>Number(formatUnits(n,decimals)).toLocaleString('en-US',{maximumSignificantDigits:6});
/**
 * Refuses a deposit the wallet cannot cover, before anything is simulated or approved, and says how much it can cover.
 * Without this the router's transferFrom fails ("TransferHelper: TRANSFER_FROM_FAILED"), which tells the user nothing.
 */
export function checkDeposit(pool:{native:bigint;token:bigint},native:bigint,token:bigint,have:{native:bigint;token:bigint},decimals:number,symbol:string){
 const need=depositNeeds(pool,native,token);
 if(need.token>have.token){
  // The largest TSYS amount the wallet's tokens cover at the current ratio, less 0.5% so a small price move still fits.
  const most=pool.token>0n?have.token*pool.native/pool.token*995n/1000n:0n;
  throw new Error(`This deposit needs ${show(need.token,decimals)} ${symbol}, but your wallet has ${show(have.token,decimals)} ${symbol}. `
   +(most>0n?`At the pool's current ratio you can deposit up to about ${show(most,18)} TSYS with it, or get more ${symbol} first.`:`Get some ${symbol} first.`)+' Nothing was sent.');
 }
 if(need.native>=have.native)throw new Error(`This deposit needs ${show(need.native,18)} TSYS plus network gas, but your wallet has ${show(have.native,18)} TSYS. Nothing was sent.`);
 return need;
}
