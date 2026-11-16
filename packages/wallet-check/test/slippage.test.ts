// Remediation of audit finding F-8 and of the review's slippage-policy concern.
// Policy: price refreshes NEVER lower the minimum; only an explicit "Accept updated price" does. The tolerance shown
// is the room actually left between the price on screen and the minimum sent, never a fixed "0.50%"; when that room
// falls below 0.10% (or the price falls below the minimum) the user must accept the current price first.
import {describe,it,expect} from 'vitest';
import {QuoteBook,effectiveSlippage,floorDisplay,toleranceBps,percentText,SLIPPAGE_BPS,MIN_EFFECTIVE_BPS,type PriceQuote} from '../src/quote-flow';
import {minimumOutput} from '../src/wallet';
const q=(output:bigint,time=1000,impact=1):PriceQuote=>({output,minimum:minimumOutput(output,SLIPPAGE_BPS),time,impact});
const book=(...outputs:bigint[])=>{const b=new QuoteBook();for(const o of outputs)b.publish(b.begin(),q(o));return b};

describe('refreshes never lower the minimum',()=>{
 it('the first quote sets the minimum exactly 0.50% below it, and the tolerance shown is 0.50%',()=>{const b=book(1000000n);expect(b.minimum).toBe(995000n);expect(b.tolerance).toBe(50);expect(percentText(b.tolerance!)).toBe('0.50');expect(effectiveSlippage(b.latest!.output,b.minimum!)).toBe(0.5)});
 it('after a small downward drift the minimum stays where it was and the smaller tolerance is shown as it is',()=>{const b=book(1000000n,997000n);expect(b.needsAcceptance).toBe(false);expect(b.minimum).toBe(995000n);expect(b.tolerance).toBe(toleranceBps(997000n,995000n));expect(percentText(b.tolerance!)).toBe('0.20')});
 it('many small declines never move the minimum down by themselves',()=>{const b=book(1000000n);for(let o=999900n;o>=980000n;o-=100n){b.publish(b.begin(),q(o));if(b.minimum!==undefined)expect(b.minimum).toBe(995000n)}expect(b.floor).toBe(995000n);expect(b.accepted!.output).toBe(1000000n)});
 it('the lowest minimum that can be sent without a new acceptance is exactly 0.50% below the accepted price',()=>{const b=book(1000000n);for(const o of [999000n,998000n,996000n,995996n]){b.publish(b.begin(),q(o));if(b.minimum!==undefined)expect(b.minimum*10000n).toBeGreaterThanOrEqual(1000000n*(10000n-BigInt(SLIPPAGE_BPS)))}});
 it('an improvement raises the minimum, measured from the better price',()=>{const b=book(1000000n,1100000n);expect(b.accepted!.output).toBe(1100000n);expect(b.minimum).toBe(1094500n);expect(b.tolerance).toBe(50)});
 it('an upward blip followed by a return leaves the higher minimum and the true, smaller tolerance (no silent 0.01%)',()=>{const b=book(1000000n,1005000n,1003000n);expect(b.minimum).toBe(q(1005000n).minimum);expect(b.tolerance).toBe(toleranceBps(1003000n,q(1005000n).minimum));expect(percentText(b.tolerance!)).toBe('0.30');b.publish(b.begin(),q(1000500n));expect(b.thin).toBe(true);expect(b.minimum).toBeUndefined()});
});

describe('when the room left is too small, or gone, the user must accept the current price',()=>{
 it('below the minimum: no minimum is offered until accepted; accepting resets it to 0.50% below the new price',()=>{const b=book(1000000n,994999n);expect(b.changed).toBe(true);expect(b.needsAcceptance).toBe(true);expect(b.minimum).toBeUndefined();b.accept(1100);expect(b.needsAcceptance).toBe(false);expect(b.minimum).toBe(q(994999n).minimum);expect(b.tolerance).toBe(50)});
 it('less than 0.10% room: nothing is offered (the swap would probably fail), not a 0.00% "limit"',()=>{const b=book(1000000n,995900n);expect(b.changed).toBe(false);expect(toleranceBps(995900n,995000n)).toBeLessThan(MIN_EFFECTIVE_BPS);expect(b.thin).toBe(true);expect(b.minimum).toBeUndefined();b.accept(1100);expect(b.minimum).toBe(q(995900n).minimum)});
 it('exactly at the minimum: thin, so acceptance is required (audit F-8: 0% tolerance is never sent silently)',()=>{const b=book(1000000n,995000n);expect(b.changed).toBe(false);expect(b.thin).toBe(true);expect(b.minimum).toBeUndefined()});
 it('exactly 0.10% room is still offered',()=>{const target=995000n*10000n/9990n+1n;const b=book(1000000n,target);expect(b.tolerance).toBeGreaterThanOrEqual(MIN_EFFECTIVE_BPS);expect(b.minimum).toBe(995000n)});
 it('a stale, failed or high-impact quote cannot be accepted',()=>{const b=book(1000000n);b.publish(b.begin(),q(900000n,1000,6));expect(()=>b.accept(1100)).toThrow();const c=new QuoteBook();c.publish(c.begin(),q(1000000n,0));c.publish(c.begin(),q(900000n,0));expect(()=>c.accept(60001)).toThrow()});
});

describe('final check after the click (quote changes during approval or wallet confirmation)',()=>{
 it('passes and leaves the screen untouched when the fresh price still honours the displayed minimum',()=>{const b=book(1000000n);const floor=b.minimum!;expect(b.confirm(floor,q(998000n))).toBe(true);expect(b.latest!.output).toBe(1000000n);expect(b.minimum).toBe(floor)});
 it('neither raises nor lowers the snapshotted minimum when the fresh price is better',()=>{const b=book(1000000n);const floor=b.minimum!;expect(b.confirm(floor,q(2000000n))).toBe(true);expect(b.minimum).toBe(floor);expect(b.accepted!.output).toBe(1000000n)});
 it('stops and shows the worse price when the fresh quote is below the displayed minimum',()=>{const b=book(1000000n);const floor=b.minimum!;expect(b.confirm(floor,q(994999n))).toBe(false);expect(b.changed).toBe(true);expect(b.latest!.output).toBe(994999n);expect(b.minimum).toBeUndefined()});
 it('stops when the fresh quote leaves less than 0.10% room above the minimum',()=>{const b=book(1000000n);const floor=b.minimum!;expect(b.confirm(floor,q(995500n))).toBe(false);expect(b.thin).toBe(true);expect(b.minimum).toBeUndefined()});
 it('discards a background quote that was in flight when the click happened',()=>{const b=book(1000000n);const inFlight=b.begin();b.confirm(b.minimum!,q(999000n));expect(b.publish(inFlight,q(500000n))).toBe(false);expect(b.latest!.output).toBe(1000000n)});
 it('keeps the accepted price through an approval, so the swap that follows is still protected',()=>{const b=book(1000000n);expect(b.confirm(b.minimum!,q(1000000n))).toBe(true);/* the approval is sent here; polling resumes afterwards */b.publish(b.begin(),q(990000n));expect(b.changed).toBe(true);expect(b.accepted!.output).toBe(1000000n);expect(b.minimum).toBeUndefined()});
 it('a price that improved during the approval raises the minimum',()=>{const b=book(1000000n);b.confirm(b.minimum!,q(1000000n));b.publish(b.begin(),q(1010000n));expect(b.needsAcceptance).toBe(false);expect(b.minimum).toBe(q(1010000n).minimum)});
});

describe('displaying an exact minimum without rounding it up',()=>{
 it('cuts to eight significant digits',()=>{expect(floorDisplay('0.009480773349999999')).toBe('0.0094807733');expect(floorDisplay('0.99999999999')).toBe('0.99999999');expect(floorDisplay('1.006883')).toBe('1.006883');expect(floorDisplay('123456789.987')).toBe('123456780');expect(floorDisplay('12.50')).toBe('12.5');expect(floorDisplay('0')).toBe('0');expect(floorDisplay('0.000000000000000001')).toBe('0.000000000000000001');expect(floorDisplay('100')).toBe('100')});
 it('is never above the value it shortens',()=>{for(const text of ['0.00999999999999','987654321.123456789','5.999999995','0.123456789123'])expect(Number(floorDisplay(text))).toBeLessThanOrEqual(Number(text))});
 it('tolerance and percent text never overstate',()=>{expect(toleranceBps(1000n,995n)).toBe(50);expect(toleranceBps(999n,995n)).toBe(40);expect(toleranceBps(995n,995n)).toBe(0);expect(toleranceBps(900n,995n)).toBe(0);expect(percentText(5)).toBe('0.05');expect(percentText(149)).toBe('1.49')});
});
