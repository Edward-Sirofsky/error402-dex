import {maxUint256} from 'viem';
import {amount} from './wallet';
export type ApprovalMode = 'unlimited'|'exact'|'custom';
export const SLIPPAGE_BPS = 50;
export interface PriceQuote {output:bigint;minimum:bigint;time:number;impact:number}
export function approvalAmount(mode:ApprovalMode,input:bigint,custom:string,decimals:number){
 const value=mode==='unlimited'?maxUint256:mode==='exact'?input:amount(custom,decimals);
 if(value<input)throw new Error('Spending limit must cover this trade.');
 if(value>maxUint256)throw new Error('Spending limit is too large.');
 return value;
}
export function approvalRequired(allowed:bigint,input:bigint,target:bigint,edited:boolean){return allowed<input||(edited&&allowed!==target)}
/**
 * Below this effective tolerance (0.10%) the held minimum leaves the swap almost no room and it would very likely
 * revert, so the user is asked to accept the current price instead (audit F-8 / fix plan B4).
 */
export const MIN_EFFECTIVE_BPS = 10;
/** Room between a price and a minimum, in basis points, rounded down (never overstated). */
export const toleranceBps=(output:bigint,minimum:bigint)=>output>0n&&output>minimum?Number((output-minimum)*10000n/output):0;
/**
 * Price protection for one trade intent. Policy: REFRESHES NEVER LOWER THE MINIMUM (the accepted-floor rule), and the
 * tolerance shown is the tolerance actually left.
 *
 * - `accepted` is the first quote, or a better one seen since, or one the user explicitly accepted. Polling can raise
 *   it, never lower it. Its `minimum` (0.50% below it) is the FLOOR: the "Minimum received" shown and sent.
 * - `latest` is the quote on screen. While it stays above the floor nothing needs accepting, but the room left
 *   (`tolerance`, shown as "Slippage limit") shrinks as the price drifts down; it is displayed as it is, never as 0.50%.
 * - `changed`: the latest price is below the floor (more than 0.50% worse than accepted).
 *   `thin`: still at or above the floor but with less than 0.10% room, so the swap would probably fail.
 *   Either way `needsAcceptance` is true, no minimum is offered, and nothing can be sent until the user explicitly
 *   accepts the current price, which resets the floor to 0.50% below it. That is the ONLY way the floor goes down.
 * - `confirm` is the last check before the wallet opens: the minimum snapshotted at the click is sent as is and is
 *   never lowered for the request being submitted.
 * Worst case without a new acceptance: the minimum sent is the accepted floor, exactly 0.50% below the accepted price.
 */
export class QuoteBook<T extends PriceQuote>{
 private revision=0;
 latest?:T; accepted?:T; error='';
 begin(){return ++this.revision}
 cancel(){++this.revision}
 reset(){this.cancel();this.latest=undefined;this.accepted=undefined;this.error=''}
 publish(ticket:number,quote:T,freeze=false){if(ticket!==this.revision)return false;this.latest=quote;if(!this.accepted||(!freeze&&quote.output>this.accepted.output))this.accepted=quote;this.error='';return true}
 fail(ticket:number,message:string){if(ticket!==this.revision)return false;this.error=message;return true}
 /** The accepted floor: what "Minimum received" shows and what a swap sends. Only `accept` can lower it. */
 get floor(){return this.accepted?.minimum}
 get changed(){return !!this.latest&&!!this.accepted&&this.latest.output<this.accepted.minimum}
 get thin(){return !!this.latest&&!!this.accepted&&!this.changed&&toleranceBps(this.latest.output,this.accepted.minimum)<MIN_EFFECTIVE_BPS}
 get needsAcceptance(){return this.changed||this.thin}
 /** The minimum a swap started now would send: the accepted floor shown on screen. Undefined while acceptance is needed. */
 get minimum(){return this.latest&&!this.needsAcceptance?this.floor:undefined}
 /** Room actually left between the price on screen and the minimum that would be sent, in basis points. */
 get tolerance(){return this.latest&&this.floor!==undefined?toleranceBps(this.latest.output,this.floor):undefined}
 accept(now=Date.now()){if(!this.latest||this.error||now-this.latest.time>60000||this.latest.impact>5)throw new Error('Wait for a fresh, tradable price.');this.accepted=this.latest}
 /**
  * Final check with a quote fetched after the click. Returns true only if the fresh price still honours the
  * minimum the user saw (`floor`) with at least 0.10% room, and is not a material adverse change from the accepted
  * price. A fresh quote can stop the trade but can never weaken its protection: when the check passes, the screen
  * (and therefore the displayed minimum, which is what gets sent) is left exactly as the user saw it; when it
  * fails, the worse price is shown so the user can review and accept it.
  */
 confirm(floor:bigint,fresh:T){
  const ok=fresh.output>=floor&&toleranceBps(fresh.output,floor)>=MIN_EFFECTIVE_BPS&&!(this.accepted&&fresh.output<this.accepted.minimum);
  this.begin(); // any background request still in flight is now out of date
  if(!ok){this.latest=fresh;this.error=''}
  return ok;
 }
 snapshot(){return {latest:this.latest,accepted:this.accepted,error:this.error,changed:this.changed,thin:this.thin,needsAcceptance:this.needsAcceptance,minimum:this.minimum,tolerance:this.tolerance}}
}
export type QuoteSnapshot<T extends PriceQuote>=ReturnType<QuoteBook<T>['snapshot']>;
/** Percent text for a basis-point figure, cut (never rounded up): 50 → "0.50". */
export const percentText=(bps:number)=>`${Math.floor(bps/100)}.${String(bps%100).padStart(2,'0')}`;
/**
 * The exact router call for a swap. `minimum` must be the snapshotted "Minimum received" from the screen; it is
 * placed in the call unchanged, so what is displayed and what is sent cannot diverge.
 */
export function swapCall(input:{fromNative:boolean;toNative:boolean;amountIn:bigint;minimum:bigint;path:readonly `0x${string}`[];account:`0x${string}`;deadline:bigint}){
 const {fromNative,toNative,amountIn,minimum,path,account,deadline}=input;
 if(fromNative)return {functionName:'swapExactETHForTokens' as const,args:[minimum,path,account,deadline] as const,value:amountIn};
 return {functionName:(toNative?'swapExactTokensForETH':'swapExactTokensForTokens') as 'swapExactTokensForETH'|'swapExactTokensForTokens',args:[amountIn,minimum,path,account,deadline] as const,value:0n};
}
/**
 * Shortens an exact decimal string to `significant` digits by cutting, never rounding up, so a displayed
 * minimum can never be higher than the real one. Text in, text out: no floating-point arithmetic.
 */
export function floorDisplay(text:string,significant=8){
 const [whole,fraction='']=text.split('.'),digits=whole+fraction,first=digits.search(/[1-9]/);
 if(first<0)return '0';
 const end=first+significant;
 if(end<=whole.length)return whole.slice(0,end)+'0'.repeat(whole.length-end);
 const kept=fraction.slice(0,end-whole.length).replace(/0+$/,'');
 return kept?`${whole}.${kept}`:whole;
}
/** Slippage actually applied between a quote and the minimum sent, in percent with two decimals (for display and tests). */
export function effectiveSlippage(output:bigint,minimum:bigint){return output>0n?Number((output-minimum)*10000n/output)/100:0}
