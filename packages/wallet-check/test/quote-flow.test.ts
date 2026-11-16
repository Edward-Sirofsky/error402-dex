import {describe,it,expect} from 'vitest';
import {maxUint256} from 'viem';
import {QuoteBook,approvalAmount,approvalRequired,type PriceQuote} from '../src/quote-flow';
const price=(output=10000n,time=1000,impact=1):PriceQuote=>({output,minimum:output*995n/1000n,time,impact});
describe('automatic quote safety',()=>{
 it('discards an old response after changing the trade',()=>{const b=new QuoteBook();const old=b.begin();b.reset();const next=b.begin();expect(b.publish(old,price())).toBe(false);expect(b.publish(next,price(20000n))).toBe(true);expect(b.latest?.output).toBe(20000n)});
 it('discards out-of-order responses and failures',()=>{const b=new QuoteBook();const a=b.begin(),z=b.begin();b.publish(z,price(20000n));expect(b.publish(a,price())).toBe(false);expect(b.fail(a,'old error')).toBe(false);expect(b.error).toBe('')});
 it('does not slowly ratchet the minimum down over repeated polls',()=>{const b=new QuoteBook();b.publish(b.begin(),price());b.publish(b.begin(),price(9970n));expect(b.changed).toBe(false);b.publish(b.begin(),price(9940n));expect(b.changed).toBe(true);expect(b.accepted?.minimum).toBe(9950n)});
 it('requires explicit acceptance before reducing the floor',()=>{const b=new QuoteBook();b.publish(b.begin(),price());b.publish(b.begin(),price(9800n));b.accept(1100);expect(b.changed).toBe(false);expect(b.accepted?.minimum).toBe(9751n)});
 it('raises protection when the displayed market improves',()=>{const b=new QuoteBook();b.publish(b.begin(),price());b.publish(b.begin(),price(20000n));expect(b.accepted?.minimum).toBe(19900n);b.publish(b.begin(),price(15000n));expect(b.changed).toBe(true)});
 it('freezes the accepted minimum during a wallet request',()=>{const b=new QuoteBook();b.publish(b.begin(),price());const floor=b.accepted?.minimum;b.publish(b.begin(),price(20000n),true);expect(b.accepted?.minimum).toBe(floor)});
 it('cancels a background request when a transaction starts',()=>{const b=new QuoteBook();const ticket=b.begin();b.cancel();expect(b.publish(ticket,price())).toBe(false)});
 it('refuses to accept stale, failed, or excessive-impact quotes',()=>{for(const q of [price(10000n,0),price(10000n,100000,6)]){const b=new QuoteBook();b.publish(b.begin(),q);expect(()=>b.accept(100001)).toThrow()}const b=new QuoteBook();b.publish(b.begin(),price());b.fail(b.begin(),'RPC unavailable');expect(()=>b.accept(1100)).toThrow()});
 it('recovers from an RPC error only after a fresh result',()=>{const b=new QuoteBook();b.publish(b.begin(),price());b.fail(b.begin(),'RPC failed');b.publish(b.begin(),price(9800n));expect(b.error).toBe('');expect(b.changed).toBe(true)});
 it('does not require acceptance at the exact accepted minimum',()=>{const b=new QuoteBook();b.publish(b.begin(),price());b.publish(b.begin(),price(9950n));expect(b.changed).toBe(false)});
});
describe('editable spending approval',()=>{
 it('uses the full uint256 limit for unlimited',()=>expect(approvalAmount('unlimited',100n,'',18)).toBe(maxUint256));
 it('supports exact amounts and custom token decimals without rounding',()=>{expect(approvalAmount('exact',123n,'',6)).toBe(123n);expect(approvalAmount('custom',123n,'2.123456',6)).toBe(2123456n);expect(()=>approvalAmount('custom',1n,'2.1234567',6)).toThrow()});
 it('rejects insufficient or overflowing limits',()=>{expect(()=>approvalAmount('custom',2000000n,'1',6)).toThrow('cover');expect(()=>approvalAmount('custom',1n,(maxUint256+1n).toString(),0)).toThrow('large')});
 it('reuses sufficient allowance without requesting unlimited again',()=>{expect(approvalRequired(100n,50n,maxUint256,false)).toBe(false);expect(approvalRequired(maxUint256,50n,maxUint256,false)).toBe(false)});
 it('updates existing unlimited approval when a smaller limit is chosen',()=>expect(approvalRequired(maxUint256,50n,50n,true)).toBe(true));
 it('does not loop after the requested allowance is confirmed',()=>expect(approvalRequired(50n,50n,50n,true)).toBe(false));
 it('reuses a partly consumed custom allowance without topping it up',()=>expect(approvalRequired(950n,50n,1000n,false)).toBe(false));
 it('requests approval when allowance has been spent or revoked',()=>expect(approvalRequired(0n,50n,maxUint256,false)).toBe(true));
});
