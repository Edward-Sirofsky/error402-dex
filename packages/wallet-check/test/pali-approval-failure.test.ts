// Regression for the real report of 16 Nov 2026: during a liquidity approval Pali showed "Can't complete transaction"
// while the page showed a "rejected / nothing submitted" message together with an "unknown submission" lock.
// SIMULATED wallet and chain: these tests fix the page's behaviour for that situation. They do not reproduce Pali
// itself, whose exact error code is not known; both plausible codes are covered.
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const write=vi.hoisted(()=>vi.fn());
vi.mock('viem',async importOriginal=>({...await importOriginal<typeof import('viem')>(),createWalletClient:()=>({writeContract:write})}));
import {send,client,walletSaid,classifyWalletError,erc20,type Connection} from '../src/wallet';
import {submitWithLock,readLocks,recover,explain,isFinal,APPROVAL_DISMISS_AFTER_MS,type ChainReader,type ChainTx,type Stage} from '../src/tx-lock';
import {networkNotice,NETWORK_STALL_SECONDS} from '../src/refresh';

const user='0x00000000000000000000000000000000000000a1' as const,router='0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff' as const,lpToken='0xda55024740502eedaf9b10f33bed4eb562c3e8ba' as const;
const approveData=('0x095ea7b3'+router.slice(2).padStart(64,'0')+'0'.repeat(48)+'016345785d89fc18') as `0x${string}`;
const h=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`;
const memory=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}}};
let c:Connection;
beforeEach(()=>{write.mockReset();c={address:user,name:'SIMULATED PALI',provider:{request:vi.fn(async({method})=>method==='eth_chainId'?'0xdee1':[user]) as any}};vi.spyOn(client,'getChainId').mockResolvedValue(57057);vi.spyOn(client,'simulateContract').mockResolvedValue({request:{}} as any);vi.spyOn(client,'estimateContractGas').mockResolvedValue(54034n);vi.spyOn(client,'waitForTransactionReceipt').mockResolvedValue({status:'success'} as any)});
afterEach(()=>vi.restoreAllMocks());
// How a wallet failure reaches this page: the wallet's error wrapped by viem (shortMessage/details/cause).
const wrapped=(inner:object)=>Object.assign(new Error('An unknown RPC error occurred.\n\nDetails: '+(inner as {message?:string}).message+'\nVersion: viem'),{shortMessage:'An unknown RPC error occurred.',details:(inner as {message?:string}).message,cause:inner});
const cantComplete=(code?:number)=>wrapped({...(code===undefined?{}:{code}),message:"Can't complete transaction"});
const approveLiquidity=(storage:ReturnType<typeof memory>,stages:Stage[]=[])=>submitWithLock({storage,kind:'approve',label:'Approve TSYS / ZKSYS LP tokens',account:user,to:lpToken,data:approveData,value:0n,deadline:null,position:async()=>({nonce:7,block:10615n}),notify:s=>stages.push(s),
 send:(onHash,before)=>send(c,lpToken,erc20,'approve',[router,99999999999999000n],onHash,0n,before)});

describe('one consistent message, carrying the wallet\'s own words',()=>{
 it('keeps the wallet\'s text and strips library noise',()=>{expect(walletSaid(cantComplete())).toBe("Can't complete transaction");expect(walletSaid(cantComplete(-32603))).toBe("Can't complete transaction");expect(walletSaid({message:'  spaced\n\tout  '})).toBe('spaced out');expect(walletSaid({data:{message:'inner detail'},message:'outer'})).toBe('inner detail')});
 it('says nothing extra for an ordinary rejection, and never returns more than one short line',()=>{expect(walletSaid(wrapped({code:4001,message:'User rejected the request.'}))).toBe('');expect(walletSaid({message:'x'.repeat(500)}).length).toBeLessThanOrEqual(160);expect(walletSaid(undefined)).toBe('');expect(walletSaid('text')).toBe('');expect(walletSaid({})).toBe('')});
 it('a wallet failure with no recognised code is UNCERTAIN only: not also "rejected"',async()=>{write.mockRejectedValue(cantComplete());expect(classifyWalletError(cantComplete())).toBe('uncertain');const error=await send(c,lpToken,erc20,'approve',[router,1n],vi.fn()).catch(e=>e);expect(error.code).toBe('TX_UNCERTAIN');expect(error.message).toContain("Your wallet said: “Can't complete transaction”");expect(error.message).not.toMatch(/reject|nothing was submitted/i)});
 it('the same failure reported with the rejection code is NOT-APPROVED only: not also "unknown"',async()=>{write.mockRejectedValue(cantComplete(4001));const error=await send(c,lpToken,erc20,'approve',[router,1n],vi.fn()).catch(e=>e);expect(error.code).toBe('TX_REJECTED');expect(error.message).toContain('nothing was submitted');expect(error.message).toContain("Can't complete transaction");expect(error.message).not.toMatch(/did not say whether|do not retry/i);expect(error.message).not.toMatch(/^You rejected/)});
 it('an internal wallet error (-32603) is uncertain and quotes the wallet',async()=>{write.mockRejectedValue(cantComplete(-32603));await expect(send(c,lpToken,erc20,'approve',[router,1n],vi.fn())).rejects.toMatchObject({code:'TX_UNCERTAIN',message:expect.stringContaining("Can't complete transaction")})});
});

describe('status and lock always agree',()=>{
 it('failure reported as not approved: the lock is gone and the last stage is "rejected"',async()=>{write.mockRejectedValue(cantComplete(4001));const s=memory(),stages:Stage[]=[];await expect(approveLiquidity(s,stages)).rejects.toMatchObject({code:'TX_REJECTED'});expect(readLocks(s)).toEqual([]);expect(stages).toEqual(['awaiting-wallet','rejected'])});
 it('failure with unknown outcome: the lock is kept and the last stage is "uncertain", never "rejected"',async()=>{write.mockRejectedValue(cantComplete());const s=memory(),stages:Stage[]=[];await expect(approveLiquidity(s,stages)).rejects.toMatchObject({code:'TX_UNCERTAIN'});expect(readLocks(s)).toHaveLength(1);expect(readLocks(s)[0]).toMatchObject({kind:'approve',uncertain:true,phase:'awaiting-wallet'});expect(stages).toEqual(['awaiting-wallet','uncertain']);expect(stages).not.toContain('rejected')});
 it('a rejection followed by a new attempt: the new request starts from "awaiting wallet", not from the old result',async()=>{const s=memory(),stages:Stage[]=[];write.mockRejectedValueOnce(cantComplete(4001));await approveLiquidity(s,stages).catch(()=>{});write.mockImplementation(()=>new Promise(()=>{}));void approveLiquidity(s,stages);await vi.waitFor(()=>expect(readLocks(s)).toHaveLength(1));expect(stages.at(-1)).toBe('awaiting-wallet');expect(readLocks(s)[0].uncertain).toBeUndefined()});
});

describe('safe recovery when the network has stopped producing blocks',()=>{
 const T0=1_794_803_496; // 04:31:36 UTC, the last block seen on 16 Nov 2026
 function stalledChain(){const txs=new Map<string,ChainTx>();const reader:ChainReader={async head(){return {number:10615n,timestamp:BigInt(T0)}},async nonce(){return 7},async receipt(){return null},async transaction(hash){return txs.get(hash)??null},async blockTransactions(){return []}};return {reader,txs}}
 it('an approval the wallet could not complete can be dismissed at once, and is never reported as confirmed or expired',async()=>{write.mockRejectedValue(cantComplete());const s=memory();await approveLiquidity(s).catch(()=>{});const [record]=readLocks(s);const {resolution}=await recover(record,stalledChain().reader,Date.now()+3600_000);expect(resolution).toEqual({state:'awaiting',until:null,dismissible:true});expect(isFinal(resolution)).toBe(false);const text=explain(record,resolution);expect(text.stage).toBe('uncertain');expect(text.text).toContain('Approve TSYS / ZKSYS LP tokens');expect(text.text).toMatch(/stop tracking/);expect(text.text).toMatch(/does not cancel/)});
 it('an approval that WAS broadcast and is stuck pending stays locked for ten minutes, then may be dismissed',async()=>{write.mockResolvedValue(h(1));vi.mocked(client.waitForTransactionReceipt).mockRejectedValue(new Error('timeout'));const s=memory();await approveLiquidity(s).catch(()=>{});const [record]=readLocks(s);expect(record).toMatchObject({phase:'submitted',hash:h(1)});const chain=stalledChain();chain.txs.set(h(1),{hash:h(1),from:user,to:lpToken,input:approveData,value:0n,nonce:7,blockNumber:null});
  expect((await recover(record,chain.reader,record.createdAt+60_000)).resolution).toEqual({state:'submitted',hash:h(1),seen:true,dismissible:false});
  const later=await recover(record,chain.reader,record.createdAt+APPROVAL_DISMISS_AFTER_MS+1);expect(later.resolution).toEqual({state:'submitted',hash:h(1),seen:true,dismissible:true});expect(explain(later.record,later.resolution).text).toMatch(/stop tracking it below, but that does not cancel it/)});
 it('a SWAP stuck pending on a stalled network is never dismissible and never unlocked by the local clock; it unlocks once a block past its deadline exists',async()=>{const chain=stalledChain();const deadline=T0+1200;const record={v:2 as const,id:'x',kind:'swap' as const,label:'Swap 0.0001 TSYS for ZKSYS',account:user,chainId:57057 as const,to:router,data:'0x7ff36ab5' as const,value:'100',deadline,nonce:7,block:'10615',createdAt:T0*1000,phase:'submitted' as const,hash:h(2)};chain.txs.set(h(2),{hash:h(2),from:user,to:router,input:'0x7ff36ab5',value:100n,nonce:7,blockNumber:null});
  // Hours of local time pass while the chain is stalled at T0: still locked, still not dismissible.
  expect((await recover(record,chain.reader,(deadline+8*3600)*1000)).resolution).toEqual({state:'submitted',hash:h(2),seen:true,dismissible:false});
  // The chain resumes and its latest block is past the deadline: the router can only revert it now.
  const resumed={...chain.reader,async head(){return {number:10616n,timestamp:BigInt(deadline+1)}}};
  expect((await recover(record,resumed,(deadline+8*3600)*1000)).resolution).toEqual({state:'expired'})});
});

describe('telling the user that the network itself is stalled',()=>{
 const head=1_794_803_496;
 it('says nothing while blocks are arriving normally (the usual gap is about five minutes)',()=>{expect(networkNotice(head,(head+309)*1000)).toBe('');expect(networkNotice(head,(head+NETWORK_STALL_SECONDS-1)*1000)).toBe('');expect(networkNotice(undefined,Date.now())).toBe('')});
 it('warns after fifteen minutes without a block, with the time of the last one',()=>{const text=networkNotice(head,(head+NETWORK_STALL_SECONDS)*1000);expect(text).toContain('since 04:31 UTC');expect(text).toContain('15 min ago');expect(text).toMatch(/may not go through/);expect(text).toMatch(/not a problem with your wallet or funds/)});
 it('reports hours for a long stall',()=>expect(networkNotice(head,(head+26570)*1000)).toContain('7 h 22 min ago'));
});
