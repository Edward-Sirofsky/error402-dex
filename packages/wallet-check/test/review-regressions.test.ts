// Permanent regressions from the independent review of the remediation (16 Nov 2026), findings R1–R3.
// The first case of each group is the reviewer's own probe, with the same inputs and the same safety expectation;
// the rest cover the additional cases the review asked for.
// SIMULATED chain and wallet only. No network, no wallet, no signature.
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {newRecord,legacyRecord,recover,explain,isFinal,readLocks,saveLock,clearLock,replaceLock,laterSameRequest,submitWithLock,routerDeadline,dismissLabel,dismissNotice,LEGACY_LOCK_KEY,LOCK_KEY,type ChainReader,type ChainTx,type PendingRecord,type Stage} from '../src/tx-lock';
import {Poller} from '../src/refresh';

const user='0x00000000000000000000000000000000000000a1' as const,token='0x00000000000000000000000000000000000000b2' as const,router='0x00000000000000000000000000000000000000c3' as const;
const h=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`;
const T=1_800_000_000;
const approveData=('0x095ea7b3'+router.slice(2).padStart(64,'0')+'f'.repeat(64)) as `0x${string}`;
const swapData='0x12345678' as const;
const memory=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)},map}};
const approval=(extra:Partial<PendingRecord>={})=>({...newRecord({kind:'approve',label:'Current approval',account:user,to:token,data:approveData,value:0n,deadline:null,nonce:8,block:100n,now:T*1000}),...extra});
const swap=(extra:Partial<PendingRecord>={})=>({...newRecord({kind:'swap',label:'Pending swap',account:user,to:router,data:swapData,value:1n,deadline:BigInt(T+1200),nonce:8,block:100n,now:T*1000}),...extra});
/** A node whose head is at `time`, with nothing from the account mined since nonce 8. */
const stalled=(time=T,head=100n):ChainReader=>({head:async()=>({number:head,timestamp:BigInt(time)}),nonce:async()=>8,receipt:async()=>null,transaction:async()=>null,blockTransactions:async()=>[]});

describe('R1 — "expired" only from on-chain facts, never from the local clock',()=>{
 it('Review probe: chain time before the deadline, PC clock 121 s past it → NOT expired',async()=>{
  const {resolution}=await recover(swap(),stalled(T),(T+1321)*1000);
  expect(resolution.state).not.toBe('expired');expect(resolution).toEqual({state:'awaiting',until:T+1200,dismissible:false});
 });
 it('a forward clock jump of a day changes nothing while the chain is before the deadline',async()=>{
  for(const jump of [1321,3600,86400,10*86400])expect((await recover(swap(),stalled(T+600),(T+jump)*1000)).resolution.state).toBe('awaiting');
 });
 it('a clock that is behind does not delay expiry once the chain is past the deadline',async()=>{
  expect((await recover(swap(),stalled(T+1201,101n),(T-86400)*1000)).resolution).toEqual({state:'expired'});
 });
 it('a lagging RPC node keeps the lock until it has a block past the deadline; then it unlocks',async()=>{
  const r=swap();
  expect((await recover(r,stalled(T+1150,99n),(T+5000)*1000)).resolution.state).toBe('awaiting'); // node 8 h behind, say
  expect((await recover(r,stalled(T+1201,140n),(T+5000)*1000)).resolution).toEqual({state:'expired'});
 });
 it('a submitted swap the node cannot see is not expired by the local clock either',async()=>{
  const r=swap({phase:'submitted',hash:h(1)});
  expect((await recover(r,stalled(T),(T+86400)*1000)).resolution).toEqual({state:'submitted',hash:h(1),seen:false,dismissible:false});
 });
 it('reads the account count AT the head block, so both facts describe one chain state',async()=>{
  const seen:bigint[]=[];const reader={...stalled(T+1201,140n),nonce:async(_a:`0x${string}`,block:bigint)=>{seen.push(block);return 8}};
  await recover(swap(),reader,T*1000);expect(seen).toEqual([140n]);
 });
 it('a node that does not have the head block (load-balanced, lagging) fails the read and the lock is kept',async()=>{
  const reader={...stalled(T+1201,140n),nonce:async()=>{throw new Error('header not found')}};
  await expect(recover(swap(),reader,T*1000)).rejects.toThrow('header not found');
 });
 it('only swap and liquidity requests carry a deadline; an approval or a legacy record never does',()=>{
  expect(routerDeadline(swap())).toBe(T+1200);
  expect(routerDeadline(approval({deadline:T+1200}))).toBeNull(); // even a tampered approval record
  expect(routerDeadline({...legacyRecord(T*1000),deadline:T+1260})).toBeNull(); // even one stored by the earlier WIP build
 });
 it('an approval is never expired, whatever the chain time or local clock',async()=>{
  for(const r of [approval(),approval({deadline:T+1200})])expect((await recover(r,stalled(T+999999),(T+999999)*1000)).resolution.state).not.toBe('expired');
 });
 it('the "expired" text states the on-chain fact it rests on',()=>{
  const {text}=explain(swap(),{state:'expired'});expect(text).toMatch(/latest block is past its time limit/);expect(text).toMatch(/no matching transaction was found/);
 });
 it('while waiting, the text does not promise an unlock time that a stalled network could break',()=>{
  const {text}=explain(swap(),{state:'awaiting',until:T+1200,dismissible:false});expect(text).toMatch(/once the network has produced a block after/);expect(text).toMatch(/stays locked until it does/);
 });
});

describe('R1 — legacy (old-format or corrupt) records: no invented deadline, honest dismissal',()=>{
 it('Review probe: an unknown legacy request is NOT expired after the previously invented time limit',async()=>{
  const {resolution}=await recover(legacyRecord(T*1000),stalled(T),(T+1381)*1000);
  expect(resolution.state).not.toBe('expired');expect(resolution).toEqual({state:'awaiting',until:null,dismissible:true});
 });
 it('an old-version APPROVAL ("unknown" in storage) is never expired, even with the chain far past any deadline',async()=>{
  const s=memory();s.setItem(LEGACY_LOCK_KEY,'unknown');const [r]=readLocks(s,T*1000);
  expect(r.deadline).toBeNull();expect((await recover(r,stalled(T+30*86400),(T+30*86400)*1000)).resolution.state).toBe('awaiting');
 });
 it('corrupt lock data is treated the same way: locked, no deadline, never expired',async()=>{
  const s=memory();s.setItem(LOCK_KEY,'{not json');const [r]=readLocks(s,T*1000);
  expect(r).toMatchObject({kind:'legacy',deadline:null});expect((await recover(r,stalled(T+86400),(T+86400)*1000)).resolution.state).toBe('awaiting');
 });
 it('a legacy hash whose transaction was replaced by an already-mined one is not reported as expired or not executed',async()=>{
  // The node no longer knows the original hash (replaced); the legacy record has no account, so the replacement
  // cannot be searched for. The page must say it cannot tell — never "expired" or "not executed".
  const r=legacyRecord(T*1000,h(9));const reader:ChainReader={...stalled(T+86400),nonce:async()=>42};
  const {resolution}=await recover(r,reader,(T+86400)*1000);
  expect(resolution).toEqual({state:'submitted',hash:h(9),seen:false,dismissible:true});expect(isFinal(resolution)).toBe(false);
  const {text}=explain(r,resolution);expect(text).toMatch(/cannot tell/);expect(text).toMatch(/does not cancel anything/);expect(text).not.toMatch(/expired|not executed|can no longer/i);
 });
 it('a legacy transaction the node shows as pending is followed, and only offered for dismissal after ten minutes, with a warning that it may still execute',async()=>{
  const r=legacyRecord(T*1000,h(9));const pending:ChainTx={hash:h(9),from:user,to:router,input:swapData,value:1n,nonce:8,blockNumber:null};
  const reader:ChainReader={...stalled(T),transaction:async()=>pending};
  expect((await recover(r,reader,(T+60)*1000)).resolution).toEqual({state:'submitted',hash:h(9),seen:true,dismissible:false});
  const later=await recover(r,reader,(T+601)*1000);expect(later.resolution).toEqual({state:'submitted',hash:h(9),seen:true,dismissible:true});
  expect(explain(later.record,later.resolution).text).toMatch(/may still go through/);
 });
 it('dismissal is described as abandoning local tracking, never as cancellation or non-execution',()=>{
  for(const r of [legacyRecord(T*1000),approval()]){
   expect(dismissNotice(r)).toMatch(/no longer tracked/);expect(dismissNotice(r)).toMatch(/did not cancel anything/);expect(dismissNotice(r)).toMatch(/may still go through/);
   expect(explain(r,{state:'awaiting',until:null,dismissible:true}).text).toMatch(/does not cancel|did not cancel|not cancel/);
  }
  expect(dismissLabel(legacyRecord(T*1000))).toMatch(/stop tracking/i);expect(dismissLabel(approval())).toMatch(/stop tracking/i);
 });
 it('a visibly pending approval offered for dismissal says it may still be mined',()=>{
  expect(explain(approval(),{state:'submitted',hash:h(1),seen:true,dismissible:true}).text).toMatch(/may still be mined/);
 });
});

describe('R1 — late callbacks never resurrect or overwrite a record',()=>{
 it('a recovery result computed before a dismissal does not bring the record back',()=>{
  const s=memory(),r=approval();saveLock(s,r);clearLock(s,r.id); // dismissed while the check was running
  expect(replaceLock(s,r,{...r,scannedTo:'150'})).toBe(false);expect(readLocks(s)).toEqual([]);
  expect(replaceLock(s,r,null)).toBe(false);
 });
 it('a recovery result computed before a late hash arrived does not overwrite it',()=>{
  const s=memory(),r=approval();saveLock(s,r);const updated={...r,phase:'submitted' as const,hash:h(5)};saveLock(s,updated);
  expect(replaceLock(s,r,{...r,scannedTo:'150'})).toBe(false);expect(replaceLock(s,r,null)).toBe(false);expect(readLocks(s)).toEqual([updated]);
 });
 it('an up-to-date result is applied',()=>{
  const s=memory(),r=approval();saveLock(s,r);expect(replaceLock(s,r,{...r,scannedTo:'150'})).toBe(true);expect(readLocks(s)[0].scannedTo).toBe('150');expect(replaceLock(s,readLocks(s)[0],null)).toBe(true);expect(readLocks(s)).toEqual([]);
 });
 const stopWaiting=()=>Object.assign(new Error('you stopped waiting'),{code:'TX_UNCERTAIN'});
 it('the wallet sends after the user stopped waiting and dismissed: the request is tracked again as submitted, without touching the page status',async()=>{
  const s=memory(),stages:Stage[]=[],late=vi.fn();let onHash!:(hash:`0x${string}`)=>void;
  await expect(submitWithLock({storage:s,kind:'approve',label:'Approve tUSD spending',account:user,to:token,data:approveData,value:0n,deadline:null,position:async()=>({nonce:8,block:100n}),notify:x=>stages.push(x),late,
   send:async(hashCallback,before)=>{onHash=hashCallback;before();throw stopWaiting()}})).rejects.toMatchObject({code:'TX_UNCERTAIN'});
  const [kept]=readLocks(s);expect(kept).toMatchObject({uncertain:true,phase:'awaiting-wallet'});
  clearLock(s,kept.id); // the user dismissed it
  onHash(h(5)); // ...and then the wallet broadcast it after all
  expect(readLocks(s)).toEqual([expect.objectContaining({id:kept.id,phase:'submitted',hash:h(5)})]);
  expect(late).toHaveBeenCalledWith(expect.objectContaining({hash:h(5)}),h(5));expect(stages).toEqual(['awaiting-wallet','uncertain']);
 });
 it('if the user stopped waiting before the wallet opened, the wallet is never opened afterwards',async()=>{
  const s=memory();let before!:()=>void;
  await expect(submitWithLock({storage:s,kind:'swap',label:'Swap',account:user,to:router,data:swapData,value:1n,deadline:BigInt(T+1200),position:async()=>({nonce:8,block:100n}),
   send:async(_h,b)=>{before=b;throw stopWaiting()}})).rejects.toMatchObject({code:'TX_UNCERTAIN'});
  expect(()=>before()).toThrow(/abandoned/);expect(readLocks(s)).toEqual([]);
 });
});

describe('R2 — a historical approval is never confirmed as the current request',()=>{
 const old:ChainTx={hash:h(1),from:user,to:token,input:approveData,value:0n,nonce:7,blockNumber:100n};
 const reader=(extra:Partial<ChainReader>={}):ChainReader=>({head:async()=>({number:101n,timestamp:BigInt(T+10)}),nonce:async()=>9,receipt:async hash=>hash===h(1)?{status:'success',transactionHash:h(1)}:null,transaction:async()=>null,blockTransactions:async n=>n===100n?[old]:[],...extra});
 it('Review probe: captured nonce 8 / block 100, old matching approval at nonce 7 in block 100, unrelated activity to nonce 9 → NOT confirmed',async()=>{
  const {resolution,record}=await recover(approval(),reader(),(T+10)*1000);
  expect(resolution.state).not.toBe('confirmed');expect(resolution).toEqual({state:'awaiting',until:null,dismissible:true});expect(record.hash).toBeUndefined();
 });
 it('the same holds when the current request has a hash the node does not show (nonce unknown)',async()=>{
  const {resolution}=await recover(approval({phase:'submitted',hash:h(2)}),reader(),(T+10)*1000);
  expect(resolution).toMatchObject({state:'submitted',hash:h(2)});
 });
 it('exact nonce equality is kept when the submitted nonce is known',async()=>{
  const {resolution}=await recover(approval({phase:'submitted',hash:h(2),txNonce:8}),reader(),(T+10)*1000);
  expect(resolution).toMatchObject({state:'submitted',hash:h(2)});
 });
 it('control: the current approval, mined at nonce 8, is still found and confirmed',async()=>{
  const current:ChainTx={...old,hash:h(3),nonce:8,blockNumber:101n};
  const r=reader({receipt:async hash=>hash===h(1)||hash===h(3)?{status:'success',transactionHash:hash}:null,blockTransactions:async n=>n===100n?[old]:n===101n?[current]:[]});
  expect((await recover(approval(),r,(T+10)*1000)).resolution).toEqual({state:'confirmed',hash:h(3),repriced:false});
 });
 it('laterSameRequest excludes anything before the captured nonce',()=>{
  const r=approval();expect(laterSameRequest(old,r)).toBe(false);expect(laterSameRequest({...old,nonce:8},r)).toBe(true);expect(laterSameRequest({...old,nonce:8},{...r,nonce:null})).toBe(false);
 });
});

describe('R3 — every poll start honours the pause predicate',()=>{
 const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve()};
 function harness(){
  let paused=false,calls=0;const pending:(()=>void)[]=[];
  const poller=new Poller(()=>new Promise<void>(resolve=>{calls++;pending.push(resolve)}),1000,()=>paused);
  return {poller,pause:(v:boolean)=>{paused=v},finish:async()=>{pending.shift()?.();await flush()},get calls(){return calls}};
 }
 it('Review probe: a follow-up queued while the first read is pending does not start after the tab is hidden',async()=>{
  let hidden=false,calls=0,release!:()=>void;
  const p=new Poller(async()=>{calls++;if(calls===1)await new Promise<void>(r=>{release=r})},1000,()=>hidden);
  p.start();p.trigger();hidden=true;release();await new Promise(r=>setTimeout(r,10));
  expect(calls).toBe(1);expect(p.pending).toBe(true);
  hidden=false;p.resume();await flush();expect(calls).toBe(2);p.stop();
 });
 it('the same for the wallet-busy predicate: no queued read starts while a wallet request is open',async()=>{
  const h=harness();h.poller.start();h.poller.trigger();h.pause(true);await h.finish();expect(h.calls).toBe(1);
  h.poller.trigger();expect(h.calls).toBe(1); // the page's post-request refresh is a trigger...
  h.pause(false);h.poller.trigger();expect(h.calls).toBe(2); // ...which runs once the wallet request is over
  h.poller.stop();
 });
 it('a direct (manual or effect) trigger while paused starts nothing and is remembered for resume',async()=>{
  const h=harness();h.pause(true);h.poller.start();expect(h.calls).toBe(0);h.poller.trigger();h.poller.trigger();expect(h.calls).toBe(0);expect(h.poller.pending).toBe(true);
  h.pause(false);h.poller.resume();expect(h.calls).toBe(1);h.poller.resume();expect(h.calls).toBe(1);h.poller.stop();
 });
 it('resume does nothing while still paused',()=>{const h=harness();h.pause(true);h.poller.start();h.poller.resume();expect(h.calls).toBe(0);h.poller.stop()});
 describe('with timers',()=>{
  beforeEach(()=>{vi.useFakeTimers()});afterEach(()=>{vi.useRealTimers()});
  it('interval ticks while paused start nothing; one refresh follows on resume',async()=>{
   const h=harness();h.poller.start();await h.finish();h.pause(true);await vi.advanceTimersByTimeAsync(10000);expect(h.calls).toBe(1);
   h.pause(false);h.poller.resume();expect(h.calls).toBe(2);await h.finish();h.poller.stop();
  });
 });
});
