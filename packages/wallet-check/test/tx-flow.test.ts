// Remediation of audit findings F-1, F-2 and F-9: one wallet request under a persisted lock, from click to outcome.
// SIMULATED wallet and chain. Real Pali / MetaMask behaviour remains a manual test.
import {describe,it,expect,vi} from 'vitest';
import {submitWithLock,readLocks,lockFor,recover,isFinal,type ChainReader,type ChainTx,type Stage,type SubmitInput} from '../src/tx-lock';

const user='0x00000000000000000000000000000000000000a1' as const,other='0x00000000000000000000000000000000000000b2' as const;
const router='0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff' as const,token='0x233440c6155e0ad350ebcf33013bc9b52ad37793' as const;
const data='0x7ff36ab5'+'22'.repeat(160) as `0x${string}`;
const h=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`;
const memory=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)},map}};
const fail=(code:string,hash?:`0x${string}`)=>Object.assign(new Error(code),{code,hash});
type Send=SubmitInput['send'];
const deadline=()=>BigInt(Math.floor(Date.now()/1000)+1200);
function request(storage:ReturnType<typeof memory>,send:Send,over:Partial<SubmitInput>={}){
 const stages:Stage[]=[];
 const input:SubmitInput={storage,kind:'swap',label:'Swap 0.0001 TSYS for ZKSYS',account:user,to:router,data,value:100n,deadline:deadline(),position:async()=>({nonce:7,block:100n}),send,notify:stage=>stages.push(stage),...over};
 return {run:()=>submitWithLock(input),stages};
}
/** Wallet behaviours. Each one calls `beforeWallet` first, exactly as the real send() does. */
const wallet={
 confirms:(hash=h(1)):Send=>async(onHash,before)=>{await before();onHash(hash)},
 rejects:():Send=>async(_onHash,before)=>{await before();throw fail('TX_REJECTED')},
 cannotTake:():Send=>async(_onHash,before)=>{await before();throw fail('TX_NOT_SENT')},
 uncertain:():Send=>async(_onHash,before)=>{await before();throw fail('TX_UNCERTAIN')},
 timesOut:(hash=h(1)):Send=>async(onHash,before)=>{await before();onHash(hash);throw fail('TX_PENDING',hash)},
 reverts:(hash=h(1)):Send=>async(onHash,before)=>{await before();onHash(hash);throw fail('TX_REVERTED',hash)},
 cancelled:(hash=h(1)):Send=>async(onHash,before)=>{await before();onHash(hash);throw fail('TX_CANCELLED',h(2))},
 replaced:(hash=h(1)):Send=>async(onHash,before)=>{await before();onHash(hash);throw fail('TX_REPLACED',h(2))},
 spedUp:():Send=>async(onHash,before)=>{await before();onHash(h(1));onHash(h(2))},
 simulationFails:():Send=>async()=>{throw new Error('execution reverted: INSUFFICIENT_OUTPUT_AMOUNT')},
 /** The page is reloaded while the prompt is open: the promise never settles in this page's lifetime. */
 neverAnswers:():Send=>async(_onHash,before)=>{await before();return new Promise(()=>{})},
};
function chain(){
 const state={head:100n,time:Math.floor(Date.now()/1000),nonce:7,receipts:new Map<string,'success'|'reverted'>(),txs:new Map<string,ChainTx>(),blocks:new Map<bigint,ChainTx[]>()};
 const reader:ChainReader={async head(){return {number:state.head,timestamp:BigInt(state.time)}},async nonce(){return state.nonce},async receipt(hash){const s=state.receipts.get(hash);return s?{status:s,transactionHash:hash}:null},async transaction(hash){return state.txs.get(hash)??null},async blockTransactions(n){return state.blocks.get(n)??[]}};
 const mine=(t:Partial<ChainTx>&{hash:`0x${string}`},status:'success'|'reverted'='success')=>{const full:ChainTx={from:user,to:router,input:data,value:100n,nonce:7,blockNumber:101n,...t};state.blocks.set(101n,[full]);state.txs.set(full.hash,full);state.receipts.set(full.hash,status);state.head=101n;state.nonce=full.nonce+1};
 return {state,reader,mine};
}

describe('outcomes that settle the request release the lock',()=>{
 it('a confirmed swap: stored before the wallet opens, marked submitted, then released',async()=>{const s=memory();const seen:string[]=[];const send:Send=async(onHash,before)=>{seen.push('before:'+readLocks(s).length);await before();seen.push('locked:'+readLocks(s)[0].phase);onHash(h(1));seen.push('hash:'+readLocks(s)[0].phase+':'+readLocks(s)[0].hash)};const r=request(s,send);await r.run();expect(seen).toEqual(['before:0','locked:awaiting-wallet','hash:submitted:'+h(1)]);expect(readLocks(s)).toEqual([]);expect(r.stages).toEqual(['awaiting-wallet','submitted','confirmed'])});
 it('an explicit rejection: nothing was sent, so it unlocks at once',async()=>{const s=memory(),r=request(s,wallet.rejects());await expect(r.run()).rejects.toMatchObject({code:'TX_REJECTED'});expect(readLocks(s)).toEqual([]);expect(r.stages).toEqual(['awaiting-wallet','rejected'])});
 it('a wallet that could not take the request (locked, busy, wrong network): unlocks at once',async()=>{const s=memory(),r=request(s,wallet.cannotTake());await expect(r.run()).rejects.toMatchObject({code:'TX_NOT_SENT'});expect(readLocks(s)).toEqual([]);expect(r.stages.at(-1)).toBe('not-sent')});
 it('a transaction that failed on-chain: unlocks',async()=>{const s=memory(),r=request(s,wallet.reverts());await expect(r.run()).rejects.toMatchObject({code:'TX_REVERTED'});expect(readLocks(s)).toEqual([]);expect(r.stages.at(-1)).toBe('reverted')});
 it('a wallet Cancel: unlocks and is never reported as confirmed',async()=>{const s=memory(),r=request(s,wallet.cancelled());await expect(r.run()).rejects.toMatchObject({code:'TX_CANCELLED'});expect(readLocks(s)).toEqual([]);expect(r.stages).toEqual(['awaiting-wallet','submitted','cancelled']);expect(r.stages).not.toContain('confirmed')});
 it('a replacement by a different transaction: unlocks and is never reported as confirmed',async()=>{const s=memory(),r=request(s,wallet.replaced());await expect(r.run()).rejects.toMatchObject({code:'TX_REPLACED'});expect(readLocks(s)).toEqual([]);expect(r.stages.at(-1)).toBe('replaced')});
 it('a wallet Speed up: the record follows the new hash and the request ends confirmed',async()=>{const s=memory();const hashes:(string|undefined)[]=[];const send:Send=async(onHash,before)=>{await before();onHash(h(1));onHash(h(2));hashes.push(readLocks(s)[0].hash,readLocks(s)[0].repricedFrom)};const r=request(s,send);await r.run();expect(hashes).toEqual([h(2),h(1)]);expect(readLocks(s)).toEqual([]);expect(r.stages.at(-1)).toBe('confirmed')});
 it('the same rules hold for approvals and liquidity',async()=>{for(const kind of ['approve','addLiquidity','removeLiquidity'] as const){const s=memory();await request(s,wallet.confirms(),{kind,deadline:kind==='approve'?null:deadline()}).run();expect(readLocks(s)).toEqual([]);const t=memory();await expect(request(t,wallet.cancelled(),{kind}).run()).rejects.toMatchObject({code:'TX_CANCELLED'});expect(readLocks(t)).toEqual([]);const u=memory();await expect(request(u,wallet.uncertain(),{kind}).run()).rejects.toMatchObject({code:'TX_UNCERTAIN'});expect(readLocks(u)[0]).toMatchObject({kind,uncertain:true})}});
});

describe('outcomes that are not settled stay locked',()=>{
 it('an uncertain wallet failure keeps the lock and marks it uncertain',async()=>{const s=memory(),r=request(s,wallet.uncertain());await expect(r.run()).rejects.toMatchObject({code:'TX_UNCERTAIN'});expect(readLocks(s)[0]).toMatchObject({phase:'awaiting-wallet',uncertain:true,nonce:7,block:'100'});expect(r.stages.at(-1)).toBe('uncertain')});
 it('a receipt timeout keeps the lock together with the hash',async()=>{const s=memory(),r=request(s,wallet.timesOut());await expect(r.run()).rejects.toMatchObject({code:'TX_PENDING'});expect(readLocks(s)[0]).toMatchObject({phase:'submitted',hash:h(1)});expect(r.stages.at(-1)).toBe('submitted')});
 it('an unknown error after the wallet opened keeps the lock (fail closed)',async()=>{const s=memory();const send:Send=async(_h,before)=>{await before();throw new Error('something unexpected')};await expect(request(s,send).run()).rejects.toThrow('unexpected');expect(readLocks(s)).toHaveLength(1)});
 it('a failed simulation never stores a lock: the wallet was not opened',async()=>{const s=memory(),r=request(s,wallet.simulationFails());await expect(r.run()).rejects.toThrow('INSUFFICIENT_OUTPUT_AMOUNT');expect(readLocks(s)).toEqual([]);expect(r.stages).toEqual([])});
});

describe('no duplicate transactions',()=>{
 it('refuses a second request while one is open, without touching the wallet',async()=>{const s=memory();await expect(request(s,wallet.uncertain()).run()).rejects.toBeDefined();const send=vi.fn(wallet.confirms());await expect(request(s,send).run()).rejects.toMatchObject({code:'TX_LOCKED'});expect(send).not.toHaveBeenCalled();expect(readLocks(s)).toHaveLength(1)});
 it('refuses when another tab opened a request after this page loaded',async()=>{const s=memory();void request(s,wallet.neverAnswers()).run();await vi.waitFor(()=>expect(readLocks(s)).toHaveLength(1));const send=vi.fn(wallet.confirms());await expect(request(s,send).run()).rejects.toMatchObject({code:'TX_LOCKED'});expect(send).not.toHaveBeenCalled()});
 it('refuses at the last moment if another tab took the lock while this one was simulating',async()=>{const s=memory();const opened=vi.fn();const send:Send=async(onHash,before)=>{void request(s,wallet.neverAnswers()).run();await Promise.resolve();await Promise.resolve();await before();opened();onHash(h(5))};await expect(request(s,send).run()).rejects.toMatchObject({code:'TX_LOCKED'});expect(opened).not.toHaveBeenCalled();expect(readLocks(s)).toHaveLength(1)});
 it('does not open the wallet if the lock cannot be stored',async()=>{const s=memory();const broken={...s,setItem:()=>{throw new Error('quota exceeded')}};const opened=vi.fn();const send:Send=async(onHash,before)=>{await before();opened();onHash(h(1))};await expect(request(broken as never,send).run()).rejects.toThrow('quota');expect(opened).not.toHaveBeenCalled()});
 it('a lock for one account does not block another account',async()=>{const s=memory();await expect(request(s,wallet.uncertain()).run()).rejects.toBeDefined();await request(s,wallet.confirms(h(8)),{account:other}).run();expect(readLocks(s)).toHaveLength(1);expect(lockFor(readLocks(s),other)).toBeUndefined();expect(lockFor(readLocks(s),user)).toBeDefined()});
 it('never calls the wallet more than once per request, whatever the outcome',async()=>{for(const behaviour of [wallet.confirms(),wallet.rejects(),wallet.uncertain(),wallet.timesOut(),wallet.cancelled(),wallet.reverts()]){const send=vi.fn(behaviour);await request(memory(),send).run().catch(()=>{});expect(send).toHaveBeenCalledTimes(1)}});
});

describe('reload while the wallet prompt is open, then recovery',()=>{
 async function reloadedDuringPrompt(over:Partial<SubmitInput>={}){const s=memory();void request(s,wallet.neverAnswers(),over).run();await Promise.resolve();await Promise.resolve();return s}
 it('the request is still there after the reload, and still blocks a new one',async()=>{const s=await reloadedDuringPrompt();const [record]=readLocks(s);expect(record).toMatchObject({phase:'awaiting-wallet',label:'Swap 0.0001 TSYS for ZKSYS',account:user});const send=vi.fn(wallet.confirms());await expect(request(s,send).run()).rejects.toMatchObject({code:'TX_LOCKED'});expect(send).not.toHaveBeenCalled()});
 it('the user then REJECTS in the wallet: it stays locked until the deadline, then unlocks by itself',async()=>{const s=await reloadedDuringPrompt();const [record]=readLocks(s);const c=chain();expect((await recover(record,c.reader)).resolution.state).toBe('awaiting');c.state.time=record.deadline!+1;const later=await recover(record,c.reader);expect(later.resolution).toEqual({state:'expired'});expect(isFinal(later.resolution)).toBe(true)});
 it('the user then CONFIRMS in the wallet: the exact transaction is found and its result reported once',async()=>{const s=await reloadedDuringPrompt();const [record]=readLocks(s);const c=chain();c.mine({hash:h(1)});const found=await recover(record,c.reader);expect(found.resolution).toEqual({state:'confirmed',hash:h(1),repriced:false});expect(found.record.hash).toBe(h(1))});
 it('the user confirms and the swap fails on-chain: reported as failed',async()=>{const s=await reloadedDuringPrompt();const c=chain();c.mine({hash:h(1)},'reverted');expect((await recover(readLocks(s)[0],c.reader)).resolution.state).toBe('reverted')});
 it('an unrelated transaction sent meanwhile does not unlock it',async()=>{const s=await reloadedDuringPrompt();const c=chain();c.mine({hash:h(3),to:token,input:'0xdeadbeef',value:0n});expect((await recover(readLocks(s)[0],c.reader)).resolution.state).toBe('awaiting')});
 it('an approval left open can be dismissed, because repeating an approval is harmless',async()=>{const s=await reloadedDuringPrompt({kind:'approve',deadline:null,to:token});expect((await recover(readLocks(s)[0],chain().reader)).resolution).toEqual({state:'awaiting',until:null,dismissible:true})});
});

describe('a submitted transaction that timed out in the page, then recovery',()=>{
 async function timedOut(){const s=memory();await request(s,wallet.timesOut()).run().catch(()=>{});return readLocks(s)[0]}
 it('still pending: stays locked',async()=>{const record=await timedOut();const c=chain();c.state.txs.set(h(1),{hash:h(1),from:user,to:router,input:data,value:100n,nonce:7,blockNumber:null});expect((await recover(record,c.reader)).resolution).toMatchObject({state:'submitted',seen:true})});
 it('later confirmed: reported confirmed',async()=>{const record=await timedOut();const c=chain();c.mine({hash:h(1)});expect((await recover(record,c.reader)).resolution.state).toBe('confirmed')});
 it('later cancelled in the wallet: reported cancelled, not confirmed',async()=>{const record=await timedOut();const c=chain();c.state.txs.set(h(1),{hash:h(1),from:user,to:router,input:data,value:100n,nonce:7,blockNumber:null});const first=await recover(record,c.reader);c.state.txs.delete(h(1));c.mine({hash:h(2),to:user,input:'0x',value:0n});expect((await recover(first.record,c.reader)).resolution).toEqual({state:'cancelled',hash:h(2)})});
 it('later sped up in the wallet: followed to the new hash',async()=>{const record=await timedOut();const c=chain();c.mine({hash:h(2)});expect((await recover(record,c.reader)).resolution).toEqual({state:'confirmed',hash:h(2),repriced:true})});
});
