import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const write=vi.hoisted(()=>vi.fn());
vi.mock('viem',async importOriginal=>({...await importOriginal<typeof import('viem')>(),createWalletClient:()=>({writeContract:write})}));
import {send,client,classifyWalletError,releasesLock,type Connection} from '../src/wallet';
// MOCK WALLET throughout. Nothing here proves how a real Pali or MetaMask behaves.
const address='0x0000000000000000000000000000000000000001';
const hash='0x'+'ab'.repeat(32),other='0x'+'cd'.repeat(32);
let c:Connection;
beforeEach(()=>{write.mockReset();c={address,name:'test',provider:{request:vi.fn(async({method})=>method==='eth_chainId'?'0xdee1':[address]) as any}};vi.spyOn(client,'getChainId').mockResolvedValue(57057);vi.spyOn(client,'simulateContract').mockResolvedValue({request:{}} as any);vi.spyOn(client,'estimateContractGas').mockResolvedValue(100n);vi.spyOn(client,'waitForTransactionReceipt').mockResolvedValue({status:'success'} as any)});
afterEach(()=>vi.restoreAllMocks());
it('persists the pre-submission lock before asking the wallet and then journals the hash',async()=>{const order:string[]=[];write.mockImplementation(async()=>{order.push('wallet');return hash});await send(c,address,[],'swap',[],()=>order.push('hash'),0n,()=>order.push('lock'));expect(order).toEqual(['lock','wallet','hash'])});
it('does not request a signature if persisting the lock fails',async()=>{await expect(send(c,address,[],'swap',[],vi.fn(),0n,()=>{throw new Error('storage unavailable')})).rejects.toThrow('storage');expect(write).not.toHaveBeenCalled()});
it('does not write a lock or open the wallet when the simulation fails',async()=>{vi.mocked(client.simulateContract).mockRejectedValue(new Error('execution reverted'));const lock=vi.fn();await expect(send(c,address,[],'swap',[],vi.fn(),0n,lock)).rejects.toThrow('reverted');expect(lock).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled()});
it('classifies a nested explicit rejection separately from uncertain submission',async()=>{write.mockRejectedValue({cause:{code:4001}});await expect(send(c,address,[],'swap',[],vi.fn())).rejects.toMatchObject({code:'TX_REJECTED'})});
it('keeps an ambiguous wallet failure uncertain',async()=>{write.mockRejectedValue(new Error('disconnected'));const journal=vi.fn();await expect(send(c,address,[],'swap',[],journal)).rejects.toMatchObject({code:'TX_UNCERTAIN'});expect(journal).not.toHaveBeenCalled();expect(releasesLock('TX_UNCERTAIN')).toBe(false)});
it('retains the returned hash when receipt lookup times out',async()=>{write.mockResolvedValue(hash);vi.mocked(client.waitForTransactionReceipt).mockRejectedValue(new Error('timeout'));const saved=vi.fn();await expect(send(c,address,[],'swap',[],saved)).rejects.toThrow('timeout');expect(saved).toHaveBeenCalledWith(hash)});
it('reports a receipt timeout as still pending, with the hash, and keeps the lock',async()=>{write.mockResolvedValue(hash);vi.mocked(client.waitForTransactionReceipt).mockRejectedValue(new Error('timeout'));await expect(send(c,address,[],'swap',[],vi.fn())).rejects.toMatchObject({code:'TX_PENDING',hash});expect(releasesLock('TX_PENDING')).toBe(false)});
it('distinguishes a mined revert from a successful transaction',async()=>{write.mockResolvedValue(hash);vi.mocked(client.waitForTransactionReceipt).mockResolvedValue({status:'reverted'} as any);await expect(send(c,address,[],'swap',[],vi.fn())).rejects.toMatchObject({code:'TX_REVERTED'})});
it('returns the receipt of a successful transaction',async()=>{write.mockResolvedValue(hash);vi.mocked(client.waitForTransactionReceipt).mockResolvedValue({status:'success',transactionHash:hash} as any);await expect(send(c,address,[],'swap',[],vi.fn())).resolves.toMatchObject({status:'success',transactionHash:hash})});

describe('wallet errors that prove nothing was sent release the lock; everything else stays locked',()=>{
 const notSent:[string,unknown][]=[
  ['wallet on another chain (viem ChainMismatchError)',Object.assign(new Error('chain mismatch'),{name:'ChainMismatchError'})],
  ['another wallet request already open (-32002)',{code:-32002,message:'Request already pending'}],
  ['wallet locked or not authorised (4100)',{code:4100}],['method unsupported (4200)',{code:4200}],
  ['wallet disconnected (4900)',{code:4900}],['wallet disconnected from this chain (4901)',{code:4901}],
  ['invalid parameters (-32602)',{code:-32602}],['a not-sent code nested inside viem wrappers',{cause:{cause:{code:-32002}}}],
 ];
 for(const [name,error] of notSent)it(name,async()=>{write.mockRejectedValue(error);expect(classifyWalletError(error)).toBe('not-sent');const journal=vi.fn();await expect(send(c,address,[],'swap',[],journal)).rejects.toMatchObject({code:'TX_NOT_SENT'});expect(journal).not.toHaveBeenCalled();expect(releasesLock('TX_NOT_SENT')).toBe(true)});
 const uncertain:[string,unknown][]=[['internal wallet error (-32603)',{code:-32603}],['node error such as "already known" (-32000)',{code:-32000,message:'already known'}],['a timeout',new Error('timed out')],['no error object at all',undefined],['a string',"boom"]];
 for(const [name,error] of uncertain)it('uncertain: '+name,()=>expect(classifyWalletError(error)).toBe('uncertain'));
 it('a user rejection wins over any other code in the chain',()=>expect(classifyWalletError({code:-32603,cause:{code:4001}})).toBe('rejected'));
 it('only final outcomes release the lock',()=>{for(const code of ['TX_REJECTED','TX_NOT_SENT','TX_REVERTED','TX_CANCELLED','TX_REPLACED'])expect(releasesLock(code)).toBe(true);for(const code of ['TX_UNCERTAIN','TX_PENDING',undefined,'OTHER'])expect(releasesLock(code)).toBe(false)});
});

describe('wallet Cancel and Speed up (replacement reported by the receipt waiter)',()=>{
 const replacedBy=(reason:'cancelled'|'repriced'|'replaced',status='success')=>vi.mocked(client.waitForTransactionReceipt).mockImplementation(async(args:any)=>{args.onReplaced?.({reason,transaction:{hash:other},replacedTransaction:{hash},transactionReceipt:{status,transactionHash:other}});return {status,transactionHash:other} as any});
 beforeEach(()=>write.mockResolvedValue(hash));
 it('a successful CANCEL transaction is never reported as success',async()=>{replacedBy('cancelled');const journal=vi.fn();await expect(send(c,address,[],'swap',[],journal)).rejects.toMatchObject({code:'TX_CANCELLED',hash:other});expect(journal).toHaveBeenCalledTimes(1);expect(releasesLock('TX_CANCELLED')).toBe(true)});
 it('a SPEED UP is followed to success and its new hash is journalled',async()=>{replacedBy('repriced');const journal=vi.fn();await expect(send(c,address,[],'swap',[],journal)).resolves.toMatchObject({status:'success',transactionHash:other});expect(journal.mock.calls.map(call=>call[0])).toEqual([hash,other])});
 it('a SPEED UP that fails on-chain is reported as failed',async()=>{replacedBy('repriced','reverted');await expect(send(c,address,[],'swap',[],vi.fn())).rejects.toMatchObject({code:'TX_REVERTED',hash:other})});
 it('a different transaction taking the nonce is reported as replaced',async()=>{replacedBy('replaced');await expect(send(c,address,[],'swap',[],vi.fn())).rejects.toMatchObject({code:'TX_REPLACED',hash:other})});
 it('a receipt for a different hash without a replacement notice is not accepted',async()=>{vi.mocked(client.waitForTransactionReceipt).mockResolvedValue({status:'success',transactionHash:other} as any);await expect(send(c,address,[],'swap',[],vi.fn())).rejects.toMatchObject({code:'TX_REPLACED'})});
 it('the same rules apply to approvals and liquidity calls, which share this code path',async()=>{replacedBy('cancelled');for(const fn of ['approve','addLiquidityETH','removeLiquidityETH','swapExactTokensForETH'])await expect(send(c,address,[],fn,[],vi.fn())).rejects.toMatchObject({code:'TX_CANCELLED'})});
});
