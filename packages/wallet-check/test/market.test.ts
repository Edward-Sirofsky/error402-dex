import {describe,it,expect} from 'vitest';
import {aggregate,removalAmounts,parallelMap,historyRanges,saveHistoryCache,readHistoryCache,type Trade,type MarketHistory} from '../src/market';
const trade=(time:number,price:number,index=0):Trade=>({time,price,index,block:BigInt(time),hash:'0x1234',side:'Buy',tokens:1,native:price});
describe('real-trade candles',()=>{
 it('orders trades and retains OHLC with summed native volume',()=>{expect(aggregate([trade(102,8),trade(100,10),trade(101,12),trade(103,9)],60)).toEqual([{time:60,open:10,high:12,low:8,close:9,volume:39}])});
 it('orders same-block logs and does not invent empty candles',()=>{const bars=aggregate([trade(100,12,2),trade(300,9),trade(100,10,1)],60);expect(bars.map(b=>b.time)).toEqual([60,300]);expect(bars[0].open).toBe(10);expect(bars[0].close).toBe(12)});
 it('does not draw non-finite or zero-price trades',()=>{expect(aggregate([trade(100,NaN),trade(101,0)],60)).toEqual([])});
});
describe('LP removal estimates',()=>{
 it('returns a proportional share with fees off',()=>{expect(removalAmounts(1200n,1200n,1000n,100n,1000000n,false)).toEqual({native:120n,token:120n})});
 it('accounts for protocol LP dilution before burning',()=>{expect(removalAmounts(1200n,1200n,1000n,100n,1000000n,true)).toEqual({native:116n,token:116n})});
 it('does not mint protocol shares when k has not grown',()=>{expect(removalAmounts(1000n,1000n,1000n,100n,1000000n,true)).toEqual({native:100n,token:100n})});
 it('refuses an empty position',()=>{expect(()=>removalAmounts(1n,1n,1n,0n,0n,false)).toThrow()});
});

describe('faster history retrieval',()=>{
 it('covers the full inclusive window exactly once in RPC-sized chunks',()=>{const ranges=historyRanges(10000n);expect(ranges[0].fromBlock).toBe(5000n);expect(ranges.at(-1)?.toBlock).toBe(10000n);for(let i=0;i<ranges.length;i++){expect(ranges[i].toBlock-ranges[i].fromBlock).toBeLessThan(500n);if(i)expect(ranges[i].fromBlock).toBe(ranges[i-1].toBlock+1n)}});
 it('does not request negative block ranges near genesis',()=>expect(historyRanges(1n)).toEqual([{fromBlock:0n,toBlock:1n}]));
 it('runs concurrent requests but caps pressure and preserves order',async()=>{let active=0,peak=0;const result=await parallelMap([3,1,2,0,5,4],async n=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,n));active--;return n*2},3);expect(result).toEqual([6,2,4,0,10,8]);expect(peak).toBe(3)});
 it('never reports a partial history as complete on RPC failure',async()=>{await expect(parallelMap([0,1],async n=>{if(n)throw new Error('RPC failed');return n})).rejects.toThrow('RPC failed')});
 it('handles an empty request list',async()=>expect(await parallelMap([],async n=>n)).toEqual([]));
});
describe('display-only history cache',()=>{
 const pair='0x0000000000000000000000000000000000000001' as const;
 const history:MarketHistory={pair,trades:[{...trade(100,10),hash:('0x'+'1'.repeat(64)) as `0x${string}`}],fromBlock:0n,toBlock:100n,updatedAt:1000};
 const memory=()=>{const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value)}}};
 it('roundtrips bigint blocks without losing precision',()=>{const storage=memory();saveHistoryCache(history,storage);expect(readHistoryCache(pair,storage,1001)).toEqual(history)});
 it('isolates markets and rejects expired or future-dated snapshots',()=>{const storage=memory();saveHistoryCache(history,storage);expect(readHistoryCache('0x0000000000000000000000000000000000000002',storage,1001)).toBeUndefined();expect(readHistoryCache(pair,storage,301001)).toBeUndefined();expect(readHistoryCache(pair,storage,999)).toBeUndefined()});
 it('rejects malformed local data and storage failures',()=>{expect(readHistoryCache(pair,{getItem:()=>'{bad'},1001)).toBeUndefined();expect(readHistoryCache(pair,{getItem:()=>{throw new Error()}},1001)).toBeUndefined();expect(()=>saveHistoryCache(history,{setItem:()=>{throw new Error()}})).not.toThrow()});
 it('refuses invalid trade prices and incomplete block ranges',()=>{const storage=memory();saveHistoryCache({...history,trades:[{...history.trades[0],price:-1}]},storage);expect(readHistoryCache(pair,storage,1001)).toBeUndefined();saveHistoryCache({...history,toBlock:99n},storage);expect(readHistoryCache(pair,storage,1001)).toBeUndefined()});
});
