import {type Address,type Hex,parseAbi,formatUnits} from 'viem';
import {client} from './wallet';
import {pairAbi} from '../../dex/src/shared';
export type Trade={hash:Hex;time:number;side:'Buy'|'Sell';price:number;tokens:number;native:number;block:bigint;index:number};
export type Bar={time:number;open:number;high:number;low:number;close:number;volume:number};
export function aggregate(trades:Trade[],seconds:number):Bar[]{
 const bars=new Map<number,Bar>();
 for(const t of [...trades].sort((a,b)=>a.time-b.time||Number(a.block-b.block)||a.index-b.index)){
  if(!Number.isFinite(t.price)||t.price<=0)continue;
  const time=Math.floor(t.time/seconds)*seconds,old=bars.get(time);
  if(old){old.high=Math.max(old.high,t.price);old.low=Math.min(old.low,t.price);old.close=t.price;old.volume+=t.native;}
  else bars.set(time,{time,open:t.price,high:t.price,low:t.price,close:t.price,volume:t.native});
 }return [...bars.values()].sort((a,b)=>a.time-b.time);
}
/** `updatedAt` is the time of the last successful chain read. `truncated` means the window holds more swaps than are kept. */
export type MarketHistory={pair:Address;trades:Trade[];fromBlock:bigint;toBlock:bigint;updatedAt:number;truncated?:boolean};
export const HISTORY_WINDOW=5000n,HISTORY_MAX_TRADES=200;
// Blocks re-read on every incremental update, so a late or reorganised block near the tip is corrected.
const HISTORY_OVERLAP=20n;
/** Preserve input order, cap RPC pressure, and reject the whole result on any failed range. */
export async function parallelMap<T,R>(items:T[],read:(item:T)=>Promise<R>,limit=4):Promise<R[]>{
 if(!Number.isInteger(limit)||limit<1)throw new Error('Invalid concurrency');
 const results:R[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;results[i]=await read(items[i])}}));
 return results;
}
export function blockRanges(from:bigint,to:bigint){
 const ranges:{fromBlock:bigint;toBlock:bigint}[]=[];
 for(let start=from;start<=to;start+=500n)ranges.push({fromBlock:start,toBlock:start+499n>to?to:start+499n});
 return ranges;
}
export function historyRanges(head:bigint){return blockRanges(head>HISTORY_WINDOW?head-HISTORY_WINDOW:0n,head)}
/**
 * Decides what an update must read. With a previous result for the same pair whose tip is still inside the
 * window, only the blocks after it (plus a small overlap) are requested; an unchanged tip needs no log request.
 */
export function historyPlan(head:bigint,previous?:Pick<MarketHistory,'toBlock'>){
 const start=head>HISTORY_WINDOW?head-HISTORY_WINDOW:0n;
 if(!previous||previous.toBlock>head||previous.toBlock<start)return {start,from:start,incremental:false,unchanged:false};
 const from=previous.toBlock>start+HISTORY_OVERLAP?previous.toBlock-HISTORY_OVERLAP:start;
 return {start,from,incremental:true,unchanged:previous.toBlock===head};
}
const tradeOrder=(a:Trade,b:Trade)=>Number(a.block-b.block)||a.index-b.index;
/** Combines kept and newly read trades: drops anything outside the window or re-read, orders them, keeps the latest 200. */
export function mergeTrades(previous:Trade[],fresh:Trade[],start:bigint,from:bigint){
 const all=[...previous.filter(t=>t.block>=start&&t.block<from),...fresh].sort(tradeOrder);
 return {trades:all.slice(-HISTORY_MAX_TRADES),truncated:all.length>HISTORY_MAX_TRADES};
}
const token0Of=new Map<string,Address>(); // token0 of a pair never changes
/**
 * Reads recent swaps. Pass the previous result from THIS page session to update cheaply; never pass data restored
 * from the display cache. Any failed request rejects the whole update, so partial data is never shown as complete.
 */
export async function marketHistory(pair:Address,wrapped:Address,decimals:number,previous?:MarketHistory):Promise<MarketHistory>{
 const key=pair.toLowerCase(),known=token0Of.get(key);
 const [head,t0]=await Promise.all([client.getBlockNumber({cacheTime:0}),known??client.readContract({address:pair,abi:pairAbi,functionName:'token0'})]);
 token0Of.set(key,t0);
 const same=previous&&previous.pair.toLowerCase()===key?previous:undefined,plan=historyPlan(head,same);
 if(same&&plan.unchanged)return {...same,updatedAt:Date.now()};
 const nativeFirst=t0.toLowerCase()===wrapped.toLowerCase();
 const batches=await parallelMap(blockRanges(plan.from,head),range=>client.getContractEvents({address:pair,abi:pairAbi,eventName:'Swap',...range}));
 const recent=batches.flat().filter(e=>!e.removed).sort((a,b)=>Number(a.blockNumber-b.blockNumber)||a.logIndex-b.logIndex).slice(-HISTORY_MAX_TRADES);
 const hashes=[...new Set(recent.map(e=>e.blockHash))];
 const blocks=await parallelMap(hashes,blockHash=>client.getBlock({blockHash}));
 const timestamps=new Map(hashes.map((hash,i)=>[hash,Number(blocks[i].timestamp)]));
 const fresh:Trade[]=recent.map(e=>{const a=e.args;const nativeIn=nativeFirst?a.amount0In!:a.amount1In!,nativeOut=nativeFirst?a.amount0Out!:a.amount1Out!;const tokenIn=nativeFirst?a.amount1In!:a.amount0In!,tokenOut=nativeFirst?a.amount1Out!:a.amount0Out!;const native=Number(formatUnits(nativeIn+nativeOut,18)),tokens=Number(formatUnits(tokenIn+tokenOut,decimals));return {hash:e.transactionHash,time:timestamps.get(e.blockHash)!,side:nativeIn>0n?'Buy':'Sell',native,tokens,price:native/tokens,block:e.blockNumber,index:e.logIndex}});
 const merged=mergeTrades(plan.incremental&&same?same.trades:[],fresh,plan.start,plan.from);
 return {pair,trades:merged.trades,fromBlock:plan.start,toBlock:head,updatedAt:Date.now(),truncated:merged.truncated||batches.flat().length>HISTORY_MAX_TRADES||(plan.incremental&&!!same?.truncated)};
}
const cacheKey=(pair:Address)=>'error402:chart:57057:v1:'+pair.toLowerCase();
// This cache is display-only. It is never used to quote or execute swaps.
export function saveHistoryCache(history:MarketHistory,storage:Pick<Storage,'setItem'>){
 try{storage.setItem(cacheKey(history.pair),JSON.stringify(history,(_,value)=>typeof value==='bigint'?value.toString():value))}catch{}
}
export function readHistoryCache(pair:Address,storage:Pick<Storage,'getItem'>,now=Date.now()):MarketHistory|undefined{
 try{
  const h=JSON.parse(storage.getItem(cacheKey(pair))??'null');
  if(!h||h.pair?.toLowerCase()!==pair.toLowerCase()||!Number.isFinite(h.updatedAt)||now-h.updatedAt>300000||h.updatedAt>now||!Array.isArray(h.trades)||h.trades.length>200)return;
  const fromBlock=BigInt(h.fromBlock),toBlock=BigInt(h.toBlock);
  if(fromBlock<0n||toBlock<fromBlock||toBlock-fromBlock>5000n)return;
  const trades:Trade[]=h.trades.map((t:Trade&{block:string})=>{
   if(!/^0x[0-9a-fA-F]{64}$/.test(t.hash)||!['Buy','Sell'].includes(t.side)||!Number.isSafeInteger(t.time)||t.time<0||!Number.isSafeInteger(t.index)||t.index<0||![t.price,t.tokens,t.native].every(n=>Number.isFinite(n)&&n>0))throw new Error('Invalid saved trade');
   const block=BigInt(t.block);if(block<fromBlock||block>toBlock)throw new Error('Invalid saved block');return {...t,block};
  });
  return {pair,trades,fromBlock,toBlock,updatedAt:h.updatedAt,...(h.truncated===true?{truncated:true}:{})};
 }catch{return}
}
export const liquidityAbi=parseAbi(['function totalSupply() view returns (uint256)','function kLast() view returns (uint256)']);
/** V2 mints protocol shares before burns; account for that dilution in minimum outputs. */
export function removalAmounts(native:bigint,token:bigint,total:bigint,owned:bigint,kLast:bigint,feeOn:boolean){
 if(total<=0n||owned<=0n)throw new Error('No liquidity to remove');
 const sqrt=(n:bigint)=>{if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n}return x};
 const root=sqrt(native*token),old=sqrt(kLast);
 const dilution=feeOn&&kLast>0n&&root>old?total*(root-old)/(root*5n+old):0n;
 return {native:native*owned/(total+dilution),token:token*owned/(total+dilution)};
}
