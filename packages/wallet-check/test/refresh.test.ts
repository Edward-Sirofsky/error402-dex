// Remediation of audit findings F-5 and F-6: automatic refresh without overlap, truthful freshness labels, dated trades.
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {Latest,Poller,freshness,freshnessText,tradeTime,utcClock} from '../src/refresh';
import {historyPlan,mergeTrades,blockRanges,historyRanges,saveHistoryCache,readHistoryCache,HISTORY_MAX_TRADES,type Trade,type MarketHistory} from '../src/market';

const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve()};
describe('polling without overlapping requests',()=>{
 beforeEach(()=>{vi.useFakeTimers()});afterEach(()=>{vi.useRealTimers()});
 function harness(interval=30000){
  let hidden=false,active=0,peak=0,started=0;const pending:(()=>void)[]=[];
  const poller=new Poller(()=>new Promise<void>(resolve=>{started++;active++;peak=Math.max(peak,active);pending.push(()=>{active--;resolve()})}),interval,()=>hidden,()=>Date.now());
  return {poller,finish:async()=>{pending.shift()?.();await flush()},hide:(v:boolean)=>{hidden=v},get started(){return started},get peak(){return peak},get waiting(){return pending.length}};
 }
 it('runs once immediately and then once per interval',async()=>{const h=harness();h.poller.start();expect(h.started).toBe(1);await h.finish();await vi.advanceTimersByTimeAsync(30000);expect(h.started).toBe(2);await h.finish();await vi.advanceTimersByTimeAsync(60000);expect(h.started).toBe(3);h.poller.stop()});
 it('never starts a second request while one is still running, however slow it is',async()=>{const h=harness();h.poller.start();await vi.advanceTimersByTimeAsync(300000);expect(h.started).toBe(1);expect(h.peak).toBe(1);h.poller.stop()});
 it('collapses any number of manual triggers during a request into exactly one follow-up',async()=>{const h=harness();h.poller.start();for(let i=0;i<10;i++)h.poller.trigger();expect(h.started).toBe(1);await h.finish();expect(h.started).toBe(2);await h.finish();expect(h.started).toBe(2);expect(h.peak).toBe(1);h.poller.stop()});
 it('makes no requests while the tab is hidden',async()=>{const h=harness();h.poller.start();await h.finish();h.hide(true);await vi.advanceTimersByTimeAsync(600000);expect(h.started).toBe(1);h.poller.stop()});
 it('refreshes at once when the tab becomes visible again after missing a tick',async()=>{const h=harness();h.poller.start();await h.finish();h.hide(true);await vi.advanceTimersByTimeAsync(90000);h.hide(false);h.poller.resume();expect(h.started).toBe(2);h.poller.stop()});
 it('does not refresh on a quick tab switch when the data is still current',async()=>{const h=harness();h.poller.start();await h.finish();await vi.advanceTimersByTimeAsync(5000);h.poller.resume();expect(h.started).toBe(1);h.poller.stop()});
 it('keeps polling after a failed request',async()=>{let calls=0;const poller=new Poller(async()=>{calls++;throw new Error('RPC failed')},30000);poller.start();await flush();await vi.advanceTimersByTimeAsync(30000);await flush();expect(calls).toBe(2);poller.stop()});
 it('stops completely: no timer, no queued follow-up',async()=>{const h=harness();h.poller.start();h.poller.trigger();h.poller.stop();await h.finish();await vi.advanceTimersByTimeAsync(120000);expect(h.started).toBe(1);h.poller.trigger();expect(h.started).toBe(1)});
 it('refuses an interval short enough to hammer the RPC',()=>{expect(()=>new Poller(async()=>{},500)).toThrow()});
});

describe('out-of-order responses',()=>{
 it('only the most recently started request may publish',()=>{const s=new Latest();const slow=s.begin(),fast=s.begin();expect(s.isCurrent(fast)).toBe(true);expect(s.isCurrent(slow)).toBe(false)});
 it('nothing may publish after the view changed',()=>{const s=new Latest();const t=s.begin();s.invalidate();expect(s.isCurrent(t)).toBe(false)});
 it('a slow old response cannot overwrite a newer one',async()=>{const s=new Latest();let shown='';const load=async(value:string,delay:number)=>{const t=s.begin();await new Promise(r=>setTimeout(r,delay));if(s.isCurrent(t))shown=value};await Promise.all([load('old',20),load('new',1)]);expect(shown).toBe('new')});
});

describe('truthful freshness states',()=>{
 const base={now:1_000_000,staleAfter:150_000};
 it('loading before anything has been read',()=>expect(freshness({...base,loading:true,failed:false})).toBe('loading'));
 it('error, not "up to date", when the first read fails',()=>expect(freshness({...base,loading:false,failed:true})).toBe('error'));
 it('fresh only after a successful read that is recent',()=>expect(freshness({...base,updatedAt:990_000,loading:false,failed:false})).toBe('fresh'));
 it('updating while a refresh is in progress',()=>expect(freshness({...base,updatedAt:990_000,loading:true,failed:false})).toBe('updating'));
 it('saved when the data came from the display cache, whatever its age',()=>expect(freshness({...base,updatedAt:999_000,loading:true,failed:false,saved:true})).toBe('saved'));
 it('stale once the last successful read is too old, even while loading',()=>{expect(freshness({...base,updatedAt:800_000,loading:false,failed:false})).toBe('stale');expect(freshness({...base,updatedAt:800_000,loading:true,failed:false})).toBe('stale')});
 it('error takes priority and still reports when the data was last good',()=>{expect(freshness({...base,updatedAt:990_000,loading:false,failed:true})).toBe('error');expect(freshnessText('Trades','error',Date.UTC(2026,10,16,10,34,15))).toContain('last updated 10:34:15 UTC')});
 it('never says "up to date"; always states a time or a problem',()=>{const at=Date.UTC(2026,10,16,10,34,15);for(const state of ['loading','saved','updating','fresh','stale','error'] as const){const text=freshnessText('Trades',state,state==='loading'?undefined:at);expect(text).not.toMatch(/up to date/i);if(state!=='loading')expect(text).toContain('10:34:15 UTC')}expect(freshnessText('Trades','stale',at)).toMatch(/out of date/);expect(freshnessText('Trades','saved',at)).toMatch(/saved copy/);expect(freshnessText('Trades','error',undefined)).toMatch(/could not load/)});
});

describe('trade dates and times (always UTC)',()=>{
 const now=Date.UTC(2026,10,16,13,0,0);
 it('shows only the time for a trade today',()=>expect(tradeTime(Date.UTC(2026,10,16,10,34,15)/1000,now)).toBe('10:34:15'));
 it('adds the day for a trade on an earlier day, so it cannot be mistaken for today',()=>expect(tradeTime(Date.UTC(2026,10,14,12,5,31)/1000,now)).toBe('14 Nov 12:05'));
 it('treats 23:59 yesterday as yesterday',()=>expect(tradeTime(Date.UTC(2026,10,15,23,59,59)/1000,now)).toBe('15 Nov 23:59'));
 it('adds the year when it differs',()=>expect(tradeTime(Date.UTC(2025,11,31,23,59,0)/1000,now)).toBe('31 Dec 2025 23:59'));
 it('stays short enough for a phone column',()=>{for(const t of [Date.UTC(2026,10,16,1,2,3),Date.UTC(2026,0,1,0,0,0),Date.UTC(2024,8,30,9,5,0)])expect(tradeTime(t/1000,now).length).toBeLessThanOrEqual(17)});
 it('does not depend on the viewer\'s time zone',()=>{const text=tradeTime(Date.UTC(2026,10,16,0,0,5)/1000,Date.UTC(2026,10,16,0,0,10));expect(text).toBe('00:00:05');expect(utcClock(Date.UTC(2026,10,16,23,59,59))).toBe('23:59:59')});
});

describe('incremental trade history',()=>{
 const trade=(block:bigint,index=0):Trade=>({hash:('0x'+block.toString(16).padStart(64,'0')) as `0x${string}`,time:Number(block),side:'Buy',price:1,tokens:1,native:1,block,index});
 it('reads the whole window when there is no previous result',()=>expect(historyPlan(10000n)).toEqual({start:5000n,from:5000n,incremental:false,unchanged:false}));
 it('reads nothing when the chain tip has not moved',()=>expect(historyPlan(10000n,{toBlock:10000n})).toMatchObject({incremental:true,unchanged:true}));
 it('reads only the new blocks plus a small overlap',()=>{const plan=historyPlan(10007n,{toBlock:10000n});expect(plan).toEqual({start:5007n,from:9980n,incremental:true,unchanged:false});expect(blockRanges(plan.from,10007n)).toEqual([{fromBlock:9980n,toBlock:10007n}])});
 it('falls back to a full read if the previous tip is ahead of the node or has left the window',()=>{expect(historyPlan(9000n,{toBlock:10000n}).incremental).toBe(false);expect(historyPlan(20000n,{toBlock:10000n}).incremental).toBe(false)});
 it('never requests a negative block near genesis',()=>{expect(historyPlan(3n,{toBlock:1n})).toEqual({start:0n,from:0n,incremental:true,unchanged:false});expect(historyRanges(1n)).toEqual([{fromBlock:0n,toBlock:1n}])});
 it('merges without duplicating re-read trades and drops trades that left the window',()=>{const previous=[trade(4000n),trade(6000n),trade(9990n),trade(9995n)];const merged=mergeTrades(previous,[trade(9990n),trade(9995n),trade(10005n)],5007n,9980n);expect(merged.trades.map(t=>t.block)).toEqual([6000n,9990n,9995n,10005n]);expect(merged.truncated).toBe(false)});
 it('lets a re-read replace a trade that was reorganised away near the tip',()=>{const merged=mergeTrades([trade(9000n),trade(9990n)],[trade(9991n)],5000n,9980n);expect(merged.trades.map(t=>t.block)).toEqual([9000n,9991n])});
 it('keeps block and log order, including two swaps in one block',()=>{const merged=mergeTrades([trade(9000n,2)],[trade(9000n,1),trade(8999n,5)],0n,9999n);expect(merged.trades.map(t=>[t.block,t.index])).toEqual([[9000n,2],[8999n,5],[9000n,1]].sort((a,b)=>Number((a[0] as bigint)-(b[0] as bigint))||(a[1] as number)-(b[1] as number)))});
 it('keeps the latest 200 and says so',()=>{const many=Array.from({length:HISTORY_MAX_TRADES+5},(_,i)=>trade(BigInt(6000+i)));const merged=mergeTrades(many,[],5000n,99999n);expect(merged.trades).toHaveLength(HISTORY_MAX_TRADES);expect(merged.trades[0].block).toBe(6005n);expect(merged.truncated).toBe(true)});
 it('the display cache carries the "latest 200 only" flag and nothing else new',()=>{const map=new Map<string,string>(),storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)}};const pair='0x0000000000000000000000000000000000000001' as const;const history:MarketHistory={pair,trades:[trade(100n)],fromBlock:0n,toBlock:100n,updatedAt:1000,truncated:true};saveHistoryCache(history,storage);expect(readHistoryCache(pair,storage,1001)).toEqual(history);saveHistoryCache({...history,truncated:false},storage);expect(readHistoryCache(pair,storage,1001)?.truncated).toBeUndefined()});
});
