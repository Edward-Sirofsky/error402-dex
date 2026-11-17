import {describe,it,expect} from 'vitest';
import {readLocks,writeLocks,saveLock,clearLock,lockFor,newRecord,legacyRecord,recover,sameRequest,explain,isFinal,LOCK_KEY,LEGACY_LOCK_KEY,SCAN_BLOCKS_PER_CHECK,type ChainReader,type ChainTx,type PendingRecord} from '../src/tx-lock';

// SIMULATED CHAIN. No wallet, no network: these tests exercise the recovery rules only.
const user='0x00000000000000000000000000000000000000a1' as const,other='0x00000000000000000000000000000000000000b2' as const;
const router='0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff' as const,token='0x233440c6155e0ad350ebcf33013bc9b52ad37793' as const;
const swapData='0x7ff36ab5'+'11'.repeat(160) as `0x${string}`;
const approveData=('0x095ea7b3'+router.slice(2).padStart(64,'0')+'f'.repeat(64)) as `0x${string}`;
const h=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`;
const T0=1_800_000_000; // request time (unix seconds)
const memory=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)},map}};
function swapRecord(extra:Partial<PendingRecord>={}):PendingRecord{
 return {...newRecord({kind:'swap',label:'Swap 0.0001 TSYS for ZKSYS',account:user,to:router,data:swapData,value:100n,deadline:BigInt(T0+1200),nonce:7,block:100n,now:T0*1000}),...extra};
}
function approveRecord(extra:Partial<PendingRecord>={}):PendingRecord{
 return {...newRecord({kind:'approve',label:'Approve tUSD spending',account:user,to:token,data:approveData,value:0n,deadline:null,nonce:7,block:100n,now:T0*1000}),...extra};
}
const tx=(hash:`0x${string}`,over:Partial<ChainTx>={}):ChainTx=>({hash,from:user,to:router,input:swapData,value:100n,nonce:7,blockNumber:null,...over});
function chain(init:{head?:bigint;time?:number;nonce?:number}={}){
 const state={head:init.head??100n,time:init.time??T0,nonce:init.nonce??7,receipts:new Map<string,'success'|'reverted'>(),txs:new Map<string,ChainTx>(),blocks:new Map<bigint,ChainTx[]>(),blockReads:0,fail:false};
 const reader:ChainReader={
  async head(){if(state.fail)throw new Error('RPC unavailable');return {number:state.head,timestamp:BigInt(state.time)}},
  async nonce(){return state.nonce},
  async receipt(hash){const s=state.receipts.get(hash.toLowerCase());return s?{status:s,transactionHash:hash}:null},
  async transaction(hash){return state.txs.get(hash.toLowerCase())??null},
  async blockTransactions(number){state.blockReads++;return state.blocks.get(number)??[]},
 };
 /** Mines a transaction: it uses the account's next nonce slot and gets a receipt. */
 const mine=(t:ChainTx,block:bigint,status:'success'|'reverted'='success')=>{const mined={...t,blockNumber:block};state.blocks.set(block,[...(state.blocks.get(block)??[]),mined]);state.txs.set(t.hash.toLowerCase(),mined);state.receipts.set(t.hash.toLowerCase(),status);if(block>state.head)state.head=block;if(t.from===user&&t.nonce>=state.nonce)state.nonce=t.nonce+1};
 return {state,reader,mine};
}
const now=(seconds:number)=>seconds*1000;

describe('stored lock records',()=>{
 it('survives a reload: a record written before the wallet opens is read back unchanged',()=>{const s=memory(),r=swapRecord();saveLock(s,r);expect(readLocks(s)).toEqual([r]);expect(lockFor(readLocks(s),user)).toEqual(r)});
 it('blocks only the account that made the request',()=>{const s=memory();saveLock(s,swapRecord());expect(lockFor(readLocks(s),other)).toBeUndefined();expect(lockFor(readLocks(s),user.toUpperCase().replace('0X','0x') as typeof user)).toBeDefined()});
 it('shows a stored request even before a wallet is connected',()=>{const s=memory();saveLock(s,swapRecord());expect(lockFor(readLocks(s),null)).toBeDefined()});
 it('keeps separate records for separate accounts and removes them independently',()=>{const s=memory(),a=swapRecord(),b={...swapRecord(),id:'b',account:other};saveLock(s,a);saveLock(s,b);expect(readLocks(s)).toHaveLength(2);clearLock(s,a.id);expect(readLocks(s)).toEqual([b]);clearLock(s,b.id);expect(s.map.has(LOCK_KEY)).toBe(false)});
 it('updates a record in place instead of duplicating it',()=>{const s=memory(),r=swapRecord();saveLock(s,r);saveLock(s,{...r,phase:'submitted',hash:h(1)});expect(readLocks(s)).toEqual([{...r,phase:'submitted',hash:h(1)}])});
 it('migrates the old "unknown" lock into a lock with NO invented deadline that blocks every account',()=>{const s=memory();s.setItem(LEGACY_LOCK_KEY,'unknown');const [r]=readLocks(s,now(T0));expect(r.kind).toBe('legacy');expect(r.phase).toBe('awaiting-wallet');expect(r.deadline).toBeNull();expect(lockFor([r],user)).toBeDefined();expect(lockFor([r],other)).toBeDefined();expect(s.map.has(LEGACY_LOCK_KEY)).toBe(false);expect(readLocks(s,now(T0+5))).toEqual([r])});
 it('migrates an old stored hash into a submitted record',()=>{const s=memory();s.setItem(LEGACY_LOCK_KEY,h(9));const [r]=readLocks(s,now(T0));expect(r.phase).toBe('submitted');expect(r.hash).toBe(h(9))});
 it('never treats corrupt or tampered data as "no lock"',()=>{for(const bad of ['{not json','[]x','{"v":2}','[{"v":2,"id":"x"}]','[{"v":1}]','null']){const s=memory();s.setItem(LOCK_KEY,bad);const records=readLocks(s,now(T0));expect(records).toHaveLength(1);expect(records[0].kind).toBe('legacy');expect(lockFor(records,user)).toBeDefined()}});
 it('rejects a record marked submitted without a hash',()=>{const s=memory();s.setItem(LOCK_KEY,JSON.stringify([{...swapRecord(),phase:'submitted'}]));expect(readLocks(s,now(T0))[0].kind).toBe('legacy')});
 it('lets a storage failure surface so the wallet is never opened without a lock',()=>{expect(()=>saveLock({getItem:()=>null,removeItem:()=>{},setItem:()=>{throw new Error('quota')}},swapRecord())).toThrow('quota');expect(()=>readLocks({getItem:()=>{throw new Error('blocked')},setItem:()=>{},removeItem:()=>{}})).toThrow('blocked')});
 it('an empty list removes the key',()=>{const s=memory();writeLocks(s,[swapRecord()]);writeLocks(s,[]);expect(s.map.size).toBe(0)});
});

describe('matching a transaction to a request',()=>{
 it('requires the same sender, contract, value and calldata',()=>{const r=swapRecord();expect(sameRequest(tx(h(1)),r)).toBe(true);expect(sameRequest(tx(h(1),{from:other}),r)).toBe(false);expect(sameRequest(tx(h(1),{to:token}),r)).toBe(false);expect(sameRequest(tx(h(1),{value:101n}),r)).toBe(false);expect(sameRequest(tx(h(1),{input:(swapData.slice(0,-2)+'12') as `0x${string}`}),r)).toBe(false);expect(sameRequest(tx(h(1),{to:null}),r)).toBe(false)});
 it('accepts an approval whose amount was edited in the wallet, but not a different spender',()=>{const r=approveRecord();const edited=(approveData.slice(0,74)+'0'.repeat(63)+'5') as `0x${string}`;expect(sameRequest(tx(h(1),{to:token,value:0n,input:edited}),r)).toBe(true);const otherSpender=('0x095ea7b3'+other.slice(2).padStart(64,'0')+'f'.repeat(64)) as `0x${string}`;expect(sameRequest(tx(h(1),{to:token,value:0n,input:otherSpender}),r)).toBe(false)});
 it('never matches a legacy record',()=>expect(sameRequest(tx(h(1)),legacyRecord(now(T0)))).toBe(false));
});

describe('recovery after a reload while the wallet prompt was open (no hash)',()=>{
 it('stays locked while the request could still be confirmed in the wallet',async()=>{const c=chain();const {resolution,record}=await recover(swapRecord(),c.reader,now(T0+30));expect(resolution).toEqual({state:'awaiting',until:T0+1200,dismissible:false});expect(isFinal(resolution)).toBe(false);expect(record.phase).toBe('awaiting-wallet')});
 it('unlocks once chain time has passed the deadline: a late broadcast can only revert',async()=>{const c=chain({time:T0+1201});expect((await recover(swapRecord(),c.reader,now(T0+1201))).resolution).toEqual({state:'expired'})});
 it('does not unlock at the deadline itself: the router still accepts a block whose timestamp equals it',async()=>{const c=chain({time:T0+1200});expect((await recover(swapRecord(),c.reader,now(T0+99999))).resolution.state).toBe('awaiting')});
 it('never unlocks by the local clock: a chain that produces no new block keeps the lock (see R1 regressions)',async()=>{const c=chain({time:T0});expect((await recover(swapRecord(),c.reader,now(T0+86400))).resolution.state).toBe('awaiting')});
 it('adopts the transaction when the user confirmed after the reload, and reports its real result',async()=>{const c=chain();c.mine(tx(h(1)),101n);const {record,resolution}=await recover(swapRecord(),c.reader,now(T0+60));expect(resolution).toEqual({state:'confirmed',hash:h(1),repriced:false});expect(record.phase).toBe('submitted');expect(record.hash).toBe(h(1))});
 it('reports a failed transaction as failed',async()=>{const c=chain();c.mine(tx(h(1)),101n,'reverted');expect((await recover(swapRecord(),c.reader,now(T0+60))).resolution).toEqual({state:'reverted',hash:h(1),repriced:false})});
 it('does not accept an unrelated transaction from the same account as the outcome',async()=>{const c=chain();c.mine(tx(h(2),{to:token,input:'0xdeadbeef',value:0n}),101n);const {resolution,record}=await recover(swapRecord(),c.reader,now(T0+60));expect(resolution.state).toBe('awaiting');expect(record.hash).toBeUndefined()});
 it('does not accept an identical request sent by a different account',async()=>{const c=chain();c.mine(tx(h(3),{from:other}),101n);c.state.nonce=8;expect((await recover(swapRecord(),c.reader,now(T0+60))).resolution.state).toBe('awaiting')});
 it('finds the transaction even when the user sent other transactions first',async()=>{const c=chain();c.mine(tx(h(2),{to:token,input:'0xdeadbeef',value:0n,nonce:7}),101n);c.mine(tx(h(1),{nonce:8}),102n);expect((await recover(swapRecord(),c.reader,now(T0+60))).resolution).toEqual({state:'confirmed',hash:h(1),repriced:false})});
 it('does not read any block when the account has sent nothing since the request',async()=>{const c=chain({head:5000n});await recover(swapRecord(),c.reader,now(T0+60));expect(c.state.blockReads).toBe(0)});
 it('keeps an uncertain wallet failure locked exactly like an open prompt',async()=>{const c=chain();const r=swapRecord({uncertain:true});expect((await recover(r,c.reader,now(T0+60))).resolution.state).toBe('awaiting');expect(explain(r,{state:'awaiting',until:T0+1200,dismissible:false}).stage).toBe('uncertain')});
 it('stays locked if the network cannot be read',async()=>{const c=chain();c.state.fail=true;await expect(recover(swapRecord(),c.reader,now(T0+5000))).rejects.toThrow('RPC unavailable')});
});

describe('recovery of a submitted transaction (hash known)',()=>{
 const submitted=(extra:Partial<PendingRecord>={})=>swapRecord({phase:'submitted',hash:h(1),...extra});
 it('reports success and failure from the receipt of that exact hash',async()=>{const a=chain();a.mine(tx(h(1)),101n);expect((await recover(submitted(),a.reader,now(T0+60))).resolution).toEqual({state:'confirmed',hash:h(1),repriced:false});const b=chain();b.mine(tx(h(1)),101n,'reverted');expect((await recover(submitted(),b.reader,now(T0+60))).resolution).toEqual({state:'reverted',hash:h(1),repriced:false})});
 it('stays locked while the transaction is genuinely pending, and remembers its nonce',async()=>{const c=chain();c.state.txs.set(h(1),tx(h(1)));const {record,resolution}=await recover(submitted(),c.reader,now(T0+60));expect(resolution).toEqual({state:'submitted',hash:h(1),seen:true,dismissible:false});expect(record.txNonce).toBe(7)});
 it('stays locked when a mined transaction has no receipt yet',async()=>{const c=chain();c.state.txs.set(h(1),tx(h(1),{blockNumber:101n}));expect((await recover(submitted(),c.reader,now(T0+5000))).resolution.state).toBe('submitted')});
 it('reports a wallet CANCEL as cancelled, never as a successful swap',async()=>{const c=chain();c.mine(tx(h(2),{to:user,input:'0x',value:0n}),101n);const {resolution}=await recover(submitted({txNonce:7}),c.reader,now(T0+60));expect(resolution).toEqual({state:'cancelled',hash:h(2)});expect(explain(submitted(),resolution).text).toMatch(/cancelled/i);expect(explain(submitted(),resolution).text).not.toMatch(/confirmed/i)});
 it('follows a wallet SPEED UP to its final result under the new hash',async()=>{const c=chain();c.mine(tx(h(2)),101n);const {record,resolution}=await recover(submitted({txNonce:7}),c.reader,now(T0+60));expect(resolution).toEqual({state:'confirmed',hash:h(2),repriced:true});expect(record.hash).toBe(h(2));expect(record.repricedFrom).toBe(h(1))});
 it('reports a sped-up transaction that failed as failed',async()=>{const c=chain();c.mine(tx(h(2)),101n,'reverted');expect((await recover(submitted({txNonce:7}),c.reader,now(T0+60))).resolution).toEqual({state:'reverted',hash:h(2),repriced:true})});
 it('reports a different transaction in the same nonce slot as replaced',async()=>{const c=chain();c.mine(tx(h(2),{to:token,input:'0xdeadbeef',value:0n}),101n);expect((await recover(submitted({txNonce:7}),c.reader,now(T0+60))).resolution).toEqual({state:'replaced',hash:h(2)})});
 it('follows a speed-up even if the node never showed the original transaction',async()=>{const c=chain();c.mine(tx(h(2)),101n);expect((await recover(submitted(),c.reader,now(T0+60))).resolution).toEqual({state:'confirmed',hash:h(2),repriced:true})});
 it('waits for the replacement to be mined before deciding',async()=>{const c=chain();c.state.blocks.set(101n,[tx(h(2),{blockNumber:101n})]);c.state.head=101n;c.state.nonce=8;expect((await recover(submitted({txNonce:7}),c.reader,now(T0+60))).resolution.state).toBe('submitted')});
 it('unlocks a dropped transaction only after its deadline, when it can no longer execute',async()=>{const c=chain();expect((await recover(submitted(),c.reader,now(T0+600))).resolution).toEqual({state:'submitted',hash:h(1),seen:false,dismissible:false});c.state.time=T0+1201;expect((await recover(submitted(),c.reader,now(T0+1201))).resolution).toEqual({state:'expired'})});
 it('does not declare expiry before the block search has caught up with the chain',async()=>{
  const c=chain({head:100n+BigInt(SCAN_BLOCKS_PER_CHECK)+50n,time:T0+5000});c.mine(tx(h(2)),100n+BigInt(SCAN_BLOCKS_PER_CHECK)+20n);c.state.time=T0+5000;
  const first=await recover(submitted({txNonce:7}),c.reader,now(T0+5000));expect(first.resolution.state).toBe('submitted');expect(c.state.blockReads).toBe(SCAN_BLOCKS_PER_CHECK);
  const second=await recover(first.record,c.reader,now(T0+5000));expect(second.resolution).toEqual({state:'confirmed',hash:h(2),repriced:true});expect(c.state.blockReads).toBeLessThanOrEqual(SCAN_BLOCKS_PER_CHECK+21);
 });
});

describe('approvals (no deadline)',()=>{
 it('never expires by time, but may be dismissed because repeating an approval is harmless',async()=>{const c=chain({time:T0+999999});expect((await recover(approveRecord(),c.reader,now(T0+999999))).resolution).toEqual({state:'awaiting',until:null,dismissible:true})});
 it('an approval confirmed after a reload, amount edited in the wallet: a possible match, never adopted as confirmed (review TX-04)',async()=>{const c=chain();const edited=(approveData.slice(0,74)+'0'.repeat(63)+'5') as `0x${string}`;c.mine(tx(h(4),{to:token,value:0n,input:edited}),101n);expect((await recover(approveRecord(),c.reader,now(T0+60))).resolution).toEqual({state:'possible',hash:h(4),dismissible:true})});
 it('cannot be dismissed while its transaction is visibly pending',async()=>{const c=chain();c.state.txs.set(h(1),tx(h(1),{to:token,value:0n,input:approveData}));expect((await recover(approveRecord({phase:'submitted',hash:h(1)}),c.reader,now(T0+60))).resolution).toMatchObject({state:'submitted',dismissible:false})});
 it('can be dismissed when the network has no trace of it',async()=>{const c=chain();expect((await recover(approveRecord({phase:'submitted',hash:h(1)}),c.reader,now(T0+60))).resolution).toMatchObject({state:'submitted',seen:false,dismissible:true})});
});

describe('legacy locks from the previous version',()=>{
 it('is never declared expired, by chain time or by the local clock: its kind and real deadline are unknown',async()=>{const r=legacyRecord(now(T0));const c=chain({time:T0});expect((await recover(r,c.reader,now(T0+600))).resolution).toEqual({state:'awaiting',until:null,dismissible:true});c.state.time=T0+86400;expect((await recover(r,c.reader,now(T0+86400))).resolution).toEqual({state:'awaiting',until:null,dismissible:true})});
 it('uses the receipt when the old lock stored a hash',async()=>{const c=chain();c.mine(tx(h(9)),101n);expect((await recover(legacyRecord(now(T0),h(9)),c.reader,now(T0+60))).resolution).toEqual({state:'confirmed',hash:h(9),repriced:false})});
});

describe('plain-language explanations',()=>{
 const r=swapRecord();
 it('names the request and distinguishes every outcome',()=>{
  expect(explain(r).stage).toBe('awaiting-wallet');expect(explain({...r,phase:'submitted',hash:h(1)}).stage).toBe('submitted');
  expect(explain(r,{state:'confirmed',hash:h(1),repriced:true})).toMatchObject({stage:'confirmed',text:expect.stringContaining('speed-up')});
  expect(explain(r,{state:'reverted',hash:h(1),repriced:false}).stage).toBe('reverted');
  expect(explain(r,{state:'replaced',hash:h(1)}).stage).toBe('replaced');
  expect(explain(r,{state:'expired'})).toMatchObject({stage:'expired',text:expect.stringContaining('unlocked')});
  expect(explain(r,{state:'awaiting',until:T0+1200,dismissible:false}).text).toContain('Swap 0.0001 TSYS for ZKSYS');
  expect(explain(approveRecord(),{state:'awaiting',until:null,dismissible:true}).text).toContain('stop tracking');
 });
});
