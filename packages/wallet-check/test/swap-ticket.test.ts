// UI-level check of the swap ticket (review note on slippage): the "Minimum received" and "Slippage limit" a user reads
// are rendered from the real component used by main.tsx, and the router call built for the click carries exactly
// that minimum. Rendered with react-dom/server (no browser, no wallet). The page's wiring between these pieces is
// `quotes.minimum` → <SwapDetails/> and `quotes.minimum` → swapCall(); app-render.test.ts renders the page itself.
import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {encodeFunctionData,formatUnits} from 'viem';
import {SwapDetails,PriceChange} from '../src/SwapDetails';
import {QuoteBook,swapCall,floorDisplay,SLIPPAGE_BPS,type PriceQuote} from '../src/quote-flow';
import {minimumOutput,routerAbi} from '../src/wallet';

const q=(output:bigint,time=1000,impact=1):PriceQuote=>({output,minimum:minimumOutput(output,SLIPPAGE_BPS),time,impact});
const book=(...outputs:bigint[])=>{const b=new QuoteBook();for(const o of outputs)b.publish(b.begin(),q(o));return b};
const text=(html:string)=>html.replace(/<[^>]+>/g,'|').replace(/\|+/g,'|');
const row=(html:string,label:string)=>{const m=new RegExp(`\\|${label}\\|([^|]*)\\|`).exec(text(html));return m?.[1]};
const render=(b:QuoteBook<PriceQuote>,decimals=18)=>renderToStaticMarkup(createElement(SwapDetails<PriceQuote>,{book:b.snapshot(),current:true,decimals,symbol:'ZKSYS',quoting:false,expired:false}));
const notice=(b:QuoteBook<PriceQuote>,decimals=18)=>renderToStaticMarkup(createElement(PriceChange<PriceQuote>,{book:b.snapshot(),current:true,decimals,symbol:'ZKSYS'}));
const user='0x00000000000000000000000000000000000000a1' as const,path=['0x00000000000000000000000000000000000000b2','0x00000000000000000000000000000000000000c3'] as const;

describe('what the swap ticket shows',()=>{
 it('fresh quote: 0.50% and the exact minimum, cut not rounded',()=>{
  const b=book(10_000_000_000_000_000n);const html=render(b);
  expect(row(html,'Slippage limit')).toBe('0.50%');expect(row(html,'Minimum received')).toBe(`${floorDisplay(formatUnits(b.minimum!,18))} ZKSYS`);
  expect(html).toContain(`title="${formatUnits(b.minimum!,18)} ZKSYS — the exact minimum sent with this swap"`);expect(html).not.toContain('Price since accepted');
 });
 it('after a drift: the held minimum, the true smaller tolerance and the drift are all shown',()=>{
  const b=book(10_000_000_000_000_000n,9_970_000_000_000_000n);const html=render(b);
  expect(row(html,'Slippage limit')).toBe('0.20%');expect(row(html,'Minimum received')).toBe('0.00995 ZKSYS');expect(row(html,'Price since accepted')).toBe('−0.30%');
  expect(notice(b)).toBe('');
 });
 it('price needs acceptance: no minimum and no tolerance are shown, and the notice says what accepting sets',()=>{
  const thin=book(10_000_000_000_000_000n,9_955_000_000_000_000n),html=render(thin);
  expect(row(html,'Slippage limit')).toBe('—');expect(row(html,'Minimum received')).toBe('— ZKSYS');
  expect(text(notice(thin))).toMatch(/held at 0\.00995 ZKSYS, only 0\.05% below the current price, so the swap would probably fail/);
  expect(text(notice(thin))).toContain(`the minimum received becomes ${floorDisplay(formatUnits(q(9_955_000_000_000_000n).minimum,18))} ZKSYS (0.50% below the current price)`);
  const worse=book(10_000_000_000_000_000n,9_000_000_000_000_000n);expect(text(notice(worse))).toMatch(/more than 0\.50% lower/);
 });
 it('6-decimal token: the same rule at tUSD precision',()=>{const b=book(1_234_567n,1_232_000n);const html=renderToStaticMarkup(createElement(SwapDetails<PriceQuote>,{book:b.snapshot(),current:true,decimals:6,symbol:'tUSD',quoting:false,expired:false}));expect(row(html,'Minimum received')).toBe(`${floorDisplay(formatUnits(b.minimum!,6))} tUSD`);expect(row(html,'Slippage limit')).toBe('0.29%')});
});

describe('what is sent is what is shown',()=>{
 const deadline=1_800_001_200n;
 it('native → token: the minimum argument is the displayed minimum, value is the input',()=>{
  const b=book(10_000_000_000_000_000n,9_970_000_000_000_000n),shown=b.minimum!;
  const call=swapCall({fromNative:true,toNative:false,amountIn:100_000_000_000_000n,minimum:shown,path,account:user,deadline});
  expect(call).toEqual({functionName:'swapExactETHForTokens',args:[shown,path,user,deadline],value:100_000_000_000_000n});
  const data=encodeFunctionData({abi:routerAbi,functionName:call.functionName,args:[...call.args]});
  expect(data).toContain(shown.toString(16).padStart(64,'0'));
  expect(row(render(b),'Minimum received')).toBe(`${floorDisplay(formatUnits(shown,18))} ZKSYS`);
 });
 it('token → native and token → token put the displayed minimum second and send no value',()=>{
  for(const toNative of [true,false]){const call=swapCall({fromNative:false,toNative,amountIn:5n,minimum:995000n,path,account:user,deadline});expect(call.functionName).toBe(toNative?'swapExactTokensForETH':'swapExactTokensForTokens');expect(call.args).toEqual([5n,995000n,path,user,deadline]);expect(call.value).toBe(0n)}
 });
 it('a price refresh after the click cannot change the minimum that is sent',()=>{
  const b=book(10_000_000_000_000_000n);const shown=b.minimum!;expect(b.confirm(shown,q(9_990_000_000_000_000n))).toBe(true);
  expect(b.minimum).toBe(shown);expect(swapCall({fromNative:true,toNative:false,amountIn:1n,minimum:b.minimum!,path,account:user,deadline}).args[0]).toBe(shown);
 });
});
