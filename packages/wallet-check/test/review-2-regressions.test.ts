// Regression tests for the second independent review of beta-0.2.0 (findings E402-01, E402-02, TX-01 to TX-04).
// SIMULATED wallets and chain. The viem tests use the REAL installed viem against a stubbed node (fetch) and a simulated
// wallet, so its own send behaviour is exercised. Real Pali / MetaMask behaviour remains a manual test.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createWalletClient,custom,type Address} from 'viem';
import {readPool,positionOf,withdrawal,checkWithdrawal,type PoolSnapshot,type SnapshotReader} from '../src/position';
import {send,erc20,singleSend,type Connection} from '../src/wallet';
import {chain} from '../../dex/src/shared';
import {submitWithLock,readLocks,saveLock,newRecord,settleLock,dropLock,loadLocks,storeLock,explain,isFinal,STORE_LOCK_NAME,LEGACY_LOCK_KEY,type StoreLock,type SubmitInput} from '../src/tx-lock';

const A='0x00000000000000000000000000000000000000a1' as Address,B='0x00000000000000000000000000000000000000b2' as Address;
const pair='0xdA55024740502eEDAF9b10f33bEd4eB562C3E8ba' as Address,wrapped='0xed563f8c2fbef9b6e95b0dce4f85f9b5787804e9' as Address,factory='0x06a9d6b2c3e9fa11a77ce80bfb35406525ddd022' as Address,other='0x6EBb170f69D886916D9ee9E585CE39E626CbC35d' as Address;
const ZERO='0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------------------------------------------
// E402-01: pool figures read at one block
// ---------------------------------------------------------------------------------------------------------------
/** A pool whose state depends on the block: at 201 someone added liquidity in exact proportion (reserves and supply doubled). */
const states:Record<string,{reserve:bigint;total:bigint;lp:Record<string,bigint>}>={
 '200':{reserve:1_000_000_000n,total:1_000_000_000n,lp:{[A.toLowerCase()]:10_000_000n,[B.toLowerCase()]:20_000_000n}},
 '201':{reserve:2_000_000_000n,total:2_000_000_000n,lp:{[A.toLowerCase()]:10_000_000n,[B.toLowerCase()]:20_000_000n}},
};
function poolReader(head:bigint){
 const calls:{functionName:string;blockNumber:bigint}[]=[];const heads:unknown[]=[];
 const reader:SnapshotReader={
  async getBlockNumber(args){heads.push(args);return head},
  async getBlock({blockNumber}){return {timestamp:1_800_000_000n+blockNumber}},
  async readContract({functionName,args,blockNumber}){
   calls.push({functionName,blockNumber});const s=states[blockNumber.toString()];
   switch(functionName){
    case 'getReserves':return [s.reserve,s.reserve,0];case 'token0':return wrapped;case 'totalSupply':return s.total;case 'kLast':return 0n;
    case 'feeTo':return ZERO;case 'balanceOf':return s.lp[(args![0] as string).toLowerCase()]??0n;default:throw new Error(functionName);
   }
  },
 };
 return {reader,calls,heads};
}
const read=(head:bigint,account:Address|null=A)=>readPool(poolReader(head).reader,{pair,account,wrapped,factory});

describe('E402-01 — every pool figure comes from one block',()=>{
 it('reads a fresh block number first, then every value (reserves, supply, fee state, LP balance, time) at that block',async()=>{
  const {reader,calls,heads}=poolReader(201n);const s=await readPool(reader,{pair,account:A,wrapped,factory});
  expect(heads).toEqual([{cacheTime:0}]);
  expect(calls.map(c=>c.functionName).sort()).toEqual(['balanceOf','feeTo','getReserves','kLast','token0','totalSupply']);
  expect(calls.every(c=>c.blockNumber===201n)).toBe(true);
  expect(s).toMatchObject({block:201n,time:1_800_000_201n,account:A,pair,lp:10_000_000n,feeOn:false});
 });
 it('the withdrawal minimum is the same before and after a proportional mint (the reviewer\'s 9.95 vs 4.975 case)',async()=>{
  for(const head of [200n,201n]){const w=withdrawal(await read(head),50);expect(w.native).toBe(10_000_000n);expect(w.minNative).toBe(9_950_000n);expect(w.minToken).toBe(9_950_000n)}
  // What the old unpinned reads could produce: block-200 reserves with the block-201 supply. Halved protection.
  const before=await read(200n),after=await read(201n),mixed:PoolSnapshot={...before,total:after.total};
  expect(withdrawal(mixed,50).minNative).toBe(4_975_000n);
 });
});

describe('E402-01 — the minimums sent are the ones shown, and only while the chain still covers them',()=>{
 it('sends the shown minimums, not ones recomputed from a later read',async()=>{
  const shown=await read(200n),fresh={...(await read(201n))};
  expect(checkWithdrawal(shown,fresh,A,50)).toEqual({lp:10_000_000n,minNative:9_950_000n,minToken:9_950_000n});
 });
 it('stops if the pool moved so far that the shown minimums are no longer covered',async()=>{
  const shown=await read(200n),fresh={...shown,block:202n,native:shown.native*99n/100n}; // 1% less TSYS behind each LP token
  expect(()=>checkWithdrawal(shown,fresh,A,50)).toThrow(/moved more than the 0\.5%/);
 });
 it('stops if the LP balance changed since it was shown (the whole position must be the one reviewed)',async()=>{
  const shown=await read(200n);
  expect(()=>checkWithdrawal(shown,{...shown,lp:5_000_000n},A,50)).toThrow(/LP balance changed/);
 });
 it('refuses when nothing has been shown yet',async()=>{const fresh=await read(200n);expect(()=>checkWithdrawal(undefined,fresh,A,50)).toThrow(/still loading/)});
});

// ---------------------------------------------------------------------------------------------------------------
// E402-02: a position belongs to the account it was read for
// ---------------------------------------------------------------------------------------------------------------
describe('E402-02 — another wallet\'s LP amount is never shown or used',()=>{
 it('A\'s position is hidden as soon as B is connected, until B\'s own position has been read',async()=>{
  const forA=await read(200n,A);
  expect(positionOf(forA,A,pair)?.lp).toBe(10_000_000n);
  expect(positionOf(forA,B,pair)).toBeUndefined(); // B connected, B's read still in flight: nothing actionable
  expect(positionOf(forA,undefined,pair)).toBeUndefined();
  expect(positionOf(forA,A.toUpperCase().replace('0X','0x') as Address,pair)?.lp).toBe(10_000_000n); // address case does not matter
  expect(positionOf(forA,A,other)).toBeUndefined(); // another pool
  expect(positionOf(await read(200n,B),B,pair)?.lp).toBe(20_000_000n);
 });
 it('a withdrawal for B can never be built from A\'s figures',async()=>{
  const forA=await read(200n,A),forB=await read(200n,B);expect(()=>checkWithdrawal(forA,forB,B,50)).toThrow(/still loading/);
 });
});

// ---------------------------------------------------------------------------------------------------------------
// TX-01 and TX-02: the real viem send path
// ---------------------------------------------------------------------------------------------------------------
const router='0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff',token='0x233440c6155e0ad350ebcf33013bc9b52ad37793';
const word=(n:number)=>n.toString(16).padStart(64,'0');
function node(method:string):unknown{
 switch(method){case 'eth_chainId':return '0xdee1';case 'eth_blockNumber':return '0x10';case 'eth_call':return '0x'+word(1);case 'eth_estimateGas':return '0x10000';case 'eth_gasPrice':return '0x1';case 'eth_getTransactionCount':return '0x7';default:throw {code:-32601,message:'method '+method+' not available'}}
}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:{body:string})=>{const body=JSON.parse(init.body);const one=(r:{id:number;method:string})=>{try{return {jsonrpc:'2.0',id:r.id,result:node(r.method)}}catch(error){return {jsonrpc:'2.0',id:r.id,error}}};return new Response(JSON.stringify(Array.isArray(body)?body.map(one):one(body)),{status:200,headers:{'content-type':'application/json'}})}))});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
/** A wallet that answers the network check and fails the send method with `error` (and also the chain check, if asked). */
function failingWallet(error:{code:number;message:string},failChainCheck=false){
 const methods:string[]=[];
 const request=vi.fn(async({method}:{method:string})=>{methods.push(method);
  if(method==='eth_chainId'){if(failChainCheck&&methods.filter(m=>m==='eth_chainId').length>2)throw error;return '0xdee1'}
  if(method==='eth_accounts')return [A];
  if(method==='eth_sendTransaction'||method==='wallet_sendTransaction')throw error;
  throw {code:-32601,message:'not available'};
 });
 return {connection:{address:A,name:'SIMULATED WALLET',provider:{request} as never} as Connection,methods,sends:()=>methods.filter(m=>m.endsWith('_sendTransaction'))};
}
const approve=(c:Connection)=>send(c,token as Address,erc20,'approve',[router,1n],()=>{});

describe('TX-02 — one click reaches the wallet\'s send method at most once',()=>{
 it('control: plain viem retries a failed eth_sendTransaction as wallet_sendTransaction (why the guard exists)',async()=>{
  const w=failingWallet({code:-32602,message:'invalid params'});
  const raw=createWalletClient({account:A,chain,transport:custom(w.connection.provider)});
  await expect(raw.sendTransaction({to:router as Address,data:'0x',gas:21000n})).rejects.toThrow();
  expect(w.sends()).toEqual(['eth_sendTransaction','wallet_sendTransaction']);
 });
 for(const [name,error,code] of [['invalid params (-32602)',{code:-32602,message:'invalid params'},'TX_NOT_SENT'],['invalid input (-32000)',{code:-32000,message:'invalid input'},'TX_UNCERTAIN'],['method not found (-32601)',{code:-32601,message:'nope'},'TX_NOT_SENT']] as const)
  it(`this page: ${name} is not retried, and the FIRST error decides the outcome (${code})`,async()=>{
   const w=failingWallet(error);
   await expect(approve(w.connection)).rejects.toMatchObject({code});
   expect(w.sends()).toEqual(['eth_sendTransaction']);
  });
 it('singleSend reports whether the send method was reached',async()=>{
  const request=vi.fn(async()=>'0x1');const once=singleSend({request} as never);
  expect(once.sendInvoked()).toBe('unknown');
  await once.provider.request({method:'eth_chainId'} as never);expect(once.sendInvoked()).toBe(false);
  await once.provider.request({method:'eth_sendTransaction',params:[{}]} as never);expect(once.sendInvoked()).toBe(true);
  await expect(once.provider.request({method:'wallet_sendTransaction',params:[{}]} as never)).rejects.toMatchObject({code:-32004});
  expect(request).toHaveBeenCalledTimes(2);
 });
});

describe('TX-01 — a disconnect after the send method was called keeps the request locked',()=>{
 for(const code of [4900,4901,-32002])
  it(`error ${code} from eth_sendTransaction: outcome unknown, never "not sent"`,async()=>{
   const w=failingWallet({code,message:'disconnected'});
   await expect(approve(w.connection)).rejects.toMatchObject({code:'TX_UNCERTAIN'});
   expect(w.sends()).toEqual(['eth_sendTransaction']);
  });
 it('the same disconnect BEFORE the send method was called: nothing can have been sent',async()=>{
  const w=failingWallet({code:4900,message:'disconnected'},true); // viem's own chain check (the third eth_chainId) fails
  await expect(approve(w.connection)).rejects.toMatchObject({code:'TX_NOT_SENT'});
  expect(w.sends()).toEqual([]);
 });
});

// ---------------------------------------------------------------------------------------------------------------
// TX-03: every write of the shared record key happens under one cross-tab lock
// ---------------------------------------------------------------------------------------------------------------
/** Storage that throws if anything is written while the store lock is not held. */
function guardedStorage(){
 const map=new Map<string,string>();let held=0;const writes:string[]=[];
 const store:StoreLock=async fn=>{held++;try{return fn()}finally{held--}};
 const assertHeld=(what:string)=>{if(!held)throw new Error('unlocked write: '+what);writes.push(what)};
 const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{assertHeld('set '+k);map.set(k,v)},removeItem:(k:string)=>{assertHeld('remove '+k);map.delete(k)},map};
 return {storage,store,writes};
}
const h=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`;
const input=(g:ReturnType<typeof guardedStorage>,sendFn:SubmitInput['send']):SubmitInput=>({storage:g.storage,store:g.store,kind:'swap',label:'Swap',account:A,to:router as Address,data:'0x7ff36ab5',value:1n,deadline:BigInt(Math.floor(Date.now()/1000)+1200),position:async()=>({nonce:7,block:100n}),send:sendFn});
const fail=(code:string)=>Object.assign(new Error(code),{code});

describe('TX-03 — no write of the stored records outside the storage lock',()=>{
 const flows:[string,SubmitInput['send'],boolean][]=[
  ['confirmed',async(onHash,before)=>{await before();onHash(h(1))},true],
  ['sped up',async(onHash,before)=>{await before();onHash(h(1));onHash(h(2))},true],
  ['rejected',async(_h,before)=>{await before();throw fail('TX_REJECTED')},false],
  ['uncertain',async(_h,before)=>{await before();throw fail('TX_UNCERTAIN')},false],
  ['still pending',async(onHash,before)=>{await before();onHash(h(1));throw fail('TX_PENDING')},false],
 ];
 for(const [name,sendFn,ok] of flows)it(`submit flow: ${name}`,async()=>{
  const g=guardedStorage();const run=submitWithLock(input(g,sendFn));
  if(ok)await run;else await expect(run).rejects.toBeTruthy();
  expect(g.writes.length).toBeGreaterThan(0);
 });
 it('a late hash after the user stopped waiting is stored under the lock too',async()=>{
  const g=guardedStorage();let late!:(hash:`0x${string}`)=>void;
  await expect(submitWithLock(input(g,async(onHash,before)=>{await before();late=onHash;throw fail('TX_UNCERTAIN')}))).rejects.toBeTruthy();
  late(h(9));await vi.waitFor(()=>expect(readLocks(g.storage)[0]).toMatchObject({hash:h(9),phase:'submitted'}));
 });
 it('recovery results, "stop tracking" and the migration of old data all write under the lock',async()=>{
  const g=guardedStorage();g.storage.map.set(LEGACY_LOCK_KEY,'unknown');
  expect(readLocks(g.storage,Date.now(),false)).toHaveLength(1); // a display read changes nothing (and does not throw)
  expect(g.writes).toEqual([]);
  const [legacy]=await loadLocks(g.store,g.storage);expect(g.writes).toContain('set error402-testnet-pending-v2');
  const r=newRecord({kind:'approve',label:'Approve',account:A,to:token as Address,data:'0x095ea7b3',value:0n,deadline:null,nonce:7,block:100n});
  await g.store(()=>saveLock(g.storage,r));
  expect(await settleLock(g.store,g.storage,r,{...r,scannedTo:'150'})).toBe(true);
  await dropLock(g.store,g.storage,legacy.id);
  expect(readLocks(g.storage).map(x=>x.id)).toEqual([r.id]);
 });
 it('storeLock uses one exclusive Web Lock for the whole site, so a second tab waits for the first',async()=>{
  const locks=(globalThis as {navigator?:{locks?:LockManager}}).navigator?.locks;
  if(!locks)return; // Node without Web Locks: nothing to check here
  const store=storeLock(locks as never);const order:string[]=[];let release!:()=>void;
  const holder=locks.request(STORE_LOCK_NAME,()=>new Promise<void>(r=>{order.push('tab A holds the lock');release=r}));
  await vi.waitFor(()=>expect(order).toEqual(['tab A holds the lock']));
  const waiting=store(()=>{order.push('tab B writes');return 1});
  await new Promise(r=>setTimeout(r,20));expect(order).toEqual(['tab A holds the lock']); // still waiting
  release();await holder;expect(await waiting).toBe(1);expect(order).toEqual(['tab A holds the lock','tab B writes']);
 });
});

// ---------------------------------------------------------------------------------------------------------------
// TX-04: wording of a possible approval match
// ---------------------------------------------------------------------------------------------------------------
describe('TX-04 — a possible approval match is never presented as this request\'s result',()=>{
 it('says it may be an earlier approval, keeps the record and offers to stop tracking',()=>{
  const r=newRecord({kind:'approve',label:'Approve ZKSYS spending',account:A,to:token as Address,data:'0x095ea7b3',value:0n,deadline:null,nonce:7,block:100n});
  const resolution={state:'possible' as const,hash:h(3),dismissible:true as const};
  const {stage,text}=explain(r,resolution);
  expect(isFinal(resolution)).toBe(false);expect(stage).toBe('uncertain');
  expect(text).toMatch(/may be an earlier approval/);expect(text).toMatch(/stop tracking/);expect(text).not.toMatch(/confirmed/);
 });
});
