import {formatUnits} from 'viem';
import {SLIPPAGE_BPS,floorDisplay,percentText,toleranceBps,type PriceQuote,type QuoteSnapshot} from './quote-flow';

// Swap-ticket details and the price-change notice, kept apart from main.tsx so the figures a user reads can be
// rendered and checked in tests. Markup and class names are those of the approved design.
const exact=(n:bigint,decimals:number)=>floorDisplay(formatUnits(n,decimals));
const fmt=(n:bigint,decimals:number)=>Number(formatUnits(n,decimals)).toLocaleString('en-US',{maximumSignificantDigits:8});
export interface TicketProps<T extends PriceQuote>{
 book:QuoteSnapshot<T>;
 /** The quote on screen belongs to the amount and tokens currently entered. */
 current:boolean;
 decimals:number;
 symbol:string;
 quoting:boolean;
 expired:boolean;
}
/** How far the price on screen is below the accepted price, in basis points (0 when it is not lower). */
const drift=<T extends PriceQuote>(book:QuoteSnapshot<T>)=>book.latest&&book.accepted&&book.latest.output<book.accepted.output?toleranceBps(book.accepted.output,book.latest.output):0;

export function SwapDetails<T extends PriceQuote>({book,current,decimals,symbol,quoting,expired}:TicketProps<T>){
 const quote=book.latest,minimum=current?book.minimum:undefined;
 // The tolerance shown is the room actually left between the price on screen and the minimum that is sent.
 const tolerance=minimum!==undefined&&book.tolerance!==undefined?`${percentText(book.tolerance)}%`:current&&book.needsAcceptance?'—':`${percentText(SLIPPAGE_BPS)}%`;
 const held=minimum!==undefined&&drift(book)>0;
 return <div className="g-details">
  <div className="g-detail"><span>Slippage limit</span><span title={minimum!==undefined?`Room between the price shown and the minimum received sent with this swap. The minimum is held at ${percentText(SLIPPAGE_BPS)}% below the price you accepted; price refreshes never lower it.`:undefined}>{tolerance}</span></div>
  <div className="g-detail"><span>Trading fee / pool</span><span>0.30%</span></div>
  <div className="g-detail"><span>Minimum received</span><span title={minimum!==undefined?`${formatUnits(minimum,decimals)} ${symbol} — the exact minimum sent with this swap`:undefined}>{minimum!==undefined?exact(minimum,decimals):'—'} {symbol}</span></div>
  {held&&<div className="g-detail"><span>Price since accepted</span><span title={`The minimum stays at ${percentText(SLIPPAGE_BPS)}% below the price you accepted.`}>−{percentText(drift(book))}%</span></div>}
  {quote&&<><div className="g-detail"><span>Price difference incl. fee</span><span>{quote.impact.toFixed(2)}%</span></div><div className="g-detail"><span>Live price</span><span>{quoting?'Updating…':expired?'Reconnecting…':'Updates automatically'}</span></div></>}
 </div>;
}

/** Shown while the price needs explicit acceptance; says what accepting changes. */
export function PriceChange<T extends PriceQuote>({book,current,decimals,symbol}:Pick<TicketProps<T>,'book'|'current'|'decimals'|'symbol'>){
 const {latest,accepted}=book;
 if(!current||!book.needsAcceptance||!latest)return null;
 const after=`If you accept, the minimum received becomes ${exact(latest.minimum,decimals)} ${symbol} (${percentText(SLIPPAGE_BPS)}% below the current price).`;
 return <section className="g-price-change" aria-live="polite"><strong>Price changed</strong>
  {book.changed
   ?<p>Previously {accepted?fmt(accepted.output,decimals):'—'} → now {fmt(latest.output,decimals)} {symbol}, more than {percentText(SLIPPAGE_BPS)}% lower. {after}</p>
   :<p>The price moved down {percentText(drift(book))}% since you accepted it. The minimum received is held at {accepted?exact(accepted.minimum,decimals):'—'} {symbol}, only {percentText(book.tolerance??0)}% below the current price, so the swap would probably fail. {after}</p>}
 </section>;
}
