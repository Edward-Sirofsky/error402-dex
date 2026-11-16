/** Guards against out-of-order async results: only the most recently started request may publish. */
export class Latest{
 private revision=0;
 begin(){return ++this.revision}
 isCurrent(ticket:number){return ticket===this.revision}
 invalidate(){++this.revision}
}
/**
 * Repeats one read-only refresh without ever overlapping itself.
 * - `start` runs immediately and then every `interval` ms.
 * - While `hidden()` is true nothing is requested; `resume` (call it when the tab becomes visible) refreshes
 *   at once if a tick was skipped or the data is older than one interval.
 * - `trigger` asks for a refresh now; if one is already running, exactly one more follows it.
 * - `hidden()` is the pause predicate (tab hidden, or a wallet request in flight). It is checked immediately before
 *   EVERY task start — interval ticks, manual triggers and the queued follow-up alike. A start refused because of it
 *   is remembered, and `resume` (or the next tick or trigger once the pause is over) runs it.
 * The task must handle its own errors; a rejection is swallowed here so polling continues.
 */
export class Poller{
 private timer?:ReturnType<typeof setInterval>;
 private running=false;private queued=false;private skipped=false;private stopped=true;private lastStart=0;
 constructor(private task:()=>Promise<void>,private interval:number,private hidden:()=>boolean=()=>false,private now:()=>number=Date.now){
  if(!Number.isFinite(interval)||interval<1000)throw new Error('Polling interval too short');
 }
 start(){if(!this.stopped)return;this.stopped=false;this.timer=setInterval(()=>this.trigger(),this.interval);this.trigger()}
 stop(){this.stopped=true;this.queued=false;if(this.timer)clearInterval(this.timer);this.timer=undefined}
 trigger(){if(this.stopped)return;if(this.running){this.queued=true;return}this.launch()}
 resume(){if(this.stopped||this.hidden())return;if(this.skipped||this.now()-this.lastStart>=this.interval)this.trigger()}
 /** True while a refresh was refused by the pause predicate and has not run since. */
 get pending(){return this.skipped}
 /** The single place a task is started: stopped and paused are re-checked here, every time. */
 private launch(){
  if(this.stopped)return;
  if(this.hidden()){this.skipped=true;return}
  void this.run();
 }
 private async run(){
  this.running=true;this.skipped=false;this.lastStart=this.now();
  try{await this.task()}catch{/* the task reports its own errors */}
  finally{this.running=false;if(this.queued){this.queued=false;this.launch()}}
 }
}
export type Freshness='loading'|'saved'|'updating'|'fresh'|'stale'|'error';
/**
 * Truthful description of how current a piece of on-chain data is.
 * `updatedAt` is the time of the last successful read; `saved` marks data restored from the display-only cache.
 */
export function freshness(input:{updatedAt?:number;loading:boolean;failed:boolean;saved?:boolean;now:number;staleAfter:number}):Freshness{
 if(input.updatedAt===undefined)return input.failed?'error':'loading';
 if(input.failed)return 'error';
 if(input.saved)return 'saved';
 if(input.now-input.updatedAt>input.staleAfter)return 'stale';
 return input.loading?'updating':'fresh';
}
/** zkSYS testnet normally produces a block at least every ~5 minutes; three missed intervals is treated as a stall. */
export const NETWORK_STALL_SECONDS=900;
/**
 * A plain warning when the network has stopped producing blocks, or '' when it looks healthy or is unknown.
 * While stalled, a wallet may refuse to send or a transaction may stay pending, whatever this page does.
 */
export function networkNotice(headTimestamp:number|undefined,nowMs:number){
 if(headTimestamp===undefined)return '';
 const idle=Math.floor(nowMs/1000)-headTimestamp;
 if(idle<NETWORK_STALL_SECONDS)return '';
 const hours=Math.floor(idle/3600),minutes=Math.floor(idle%3600/60);
 return `zkSYS testnet has not produced a new block since ${utcClock(headTimestamp*1000).slice(0,5)} UTC (${hours?`${hours} h `:''}${minutes} min ago). Transactions may not go through right now and your wallet may show an error: a network condition, not a problem with your wallet or funds.`;
}
const two=(n:number)=>String(n).padStart(2,'0');
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** HH:MM:SS in UTC. Every time on the page is UTC, matching the chart axis. */
export function utcClock(ms:number){const d=new Date(ms);return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`}
/**
 * Trade time for the table, in UTC. Today's trades show the time only; older ones show the day as well,
 * and the year when it differs, so trades from different days cannot be mistaken for each other.
 */
export function tradeTime(seconds:number,nowMs:number){
 const d=new Date(seconds*1000),n=new Date(nowMs);
 if(d.getUTCFullYear()===n.getUTCFullYear()&&d.getUTCMonth()===n.getUTCMonth()&&d.getUTCDate()===n.getUTCDate())return utcClock(seconds*1000);
 const day=`${d.getUTCDate()} ${months[d.getUTCMonth()]}`,time=`${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
 return d.getUTCFullYear()===n.getUTCFullYear()?`${day} ${time}`:`${day} ${d.getUTCFullYear()} ${time}`;
}
/** Wording for a data-freshness label. `what` is e.g. "Trades" or "Pool". */
export function freshnessText(what:string,state:Freshness,updatedAt:number|undefined){
 const at=updatedAt===undefined?'':`${utcClock(updatedAt)} UTC`;
 switch(state){
  case 'loading':return `${what}: loading from the chain…`;
  case 'saved':return `${what}: showing a saved copy from ${at} while fresh data loads…`;
  case 'updating':return `${what}: updated ${at} · checking for changes…`;
  case 'fresh':return `${what}: updated ${at}`;
  case 'stale':return `${what}: last updated ${at} — this may be out of date; refreshing…`;
  case 'error':return updatedAt===undefined?`${what}: could not load. Retrying automatically.`:`${what}: could not refresh — last updated ${at}. Retrying automatically.`;
 }
}
