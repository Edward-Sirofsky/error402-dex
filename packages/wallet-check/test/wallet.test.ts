import {describe,it,expect,vi} from 'vitest';
import {transactionDeadline,amount,guard,client,type Connection} from '../src/wallet';
describe('wallet safety checks',()=>{
 it('parses token decimals exactly and refuses rounding',()=>{expect(amount('1.000001',6)).toBe(1000001n);expect(()=>amount('1.0000001',6)).toThrow();expect(()=>amount('0',18)).toThrow();expect(()=>amount('-1',18)).toThrow();expect(()=>amount('1e3',18)).toThrow()});
 it('rejects wrong network before RPC or signing',async()=>{const request=vi.fn().mockResolvedValue('0x1644');await expect(guard({address:'0x0000000000000000000000000000000000000001',name:'MOCK WALLET',provider:{request}} as Connection)).rejects.toThrow('57057');expect(request).toHaveBeenCalledTimes(1)});
 it('rejects a changed account before signing',async()=>{const request=vi.fn().mockResolvedValueOnce('0xdee1').mockResolvedValueOnce(['0x0000000000000000000000000000000000000002']);await expect(guard({address:'0x0000000000000000000000000000000000000001',name:'MOCK WALLET',provider:{request}} as Connection)).rejects.toThrow('changed')});
 it('also rejects an RPC on a different chain',async()=>{const id=vi.spyOn(client,'getChainId').mockResolvedValueOnce(57);const address='0x0000000000000000000000000000000000000001';const request=vi.fn().mockResolvedValueOnce('0xdee1').mockResolvedValueOnce([address]);await expect(guard({address,name:'MOCK WALLET',provider:{request}} as Connection)).rejects.toThrow('Wrong network');id.mockRestore()});
});

describe('wallet confirmation deadlines',()=>{
 it('does not expire against wall time when the latest block is stale',()=>{const now=1794630881000;expect(transactionDeadline(1794630571n,now)).toBe(1794632081n)});
 it('allows twenty minutes when the chain clock is ahead',()=>{expect(transactionDeadline(2000n,1000000)).toBe(3200n)});
});