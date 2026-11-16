import {useEffect,useRef} from 'react';
import {createChart,CandlestickSeries,HistogramSeries,ColorType,type UTCTimestamp} from 'lightweight-charts';
import {aggregate,type Trade} from './market';
// The library draws its TradingView mark (19px tall, 10px from the edges) inside the BOTTOM pane, which here is the
// volume pane. That pane must therefore never be shorter than the mark needs, or the mark is clipped.
const LOGO_WIDTH=35,LOGO_INSET=10,LOGO_HEIGHT=19;
/** Height of the volume pane: about a fifth of the chart, but always tall enough for the whole attribution mark. */
export function volumePaneHeight(chartHeight:number){return Math.max(LOGO_HEIGHT+LOGO_INSET*2+2,Math.min(72,Math.round(chartHeight*.2)))}
/** Empty bar slots kept at the left so the first bars do not start underneath the attribution mark. */
export function leftPadding(plotWidth:number,span:number){const clear=LOGO_WIDTH+LOGO_INSET*2;return plotWidth>clear*2?Math.ceil(clear*span/(plotWidth-clear)):2}
export function MarketChart({trades,period,mode}:{trades:Trade[];period:number;mode:'light'|'dark'}){
 const ref=useRef<HTMLElement>(null);
 useEffect(()=>{
  const host=ref.current;if(!host)return;
  const css=getComputedStyle(host),color=(name:string)=>css.getPropertyValue(name).trim();
  const chart=createChart(host,{autoSize:true,height:350,layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:color('--muted'),attributionLogo:true},grid:{vertLines:{visible:false},horzLines:{color:color('--edge')}},timeScale:{timeVisible:true,secondsVisible:false,borderVisible:false},rightPriceScale:{borderVisible:false},handleScroll:{vertTouchDrag:false}});
  const up=color('--up'),down=color('--down');
  const series=chart.addSeries(CandlestickSeries,{upColor:up,downColor:down,wickUpColor:up,wickDownColor:down,borderVisible:false,priceFormat:{type:'price',precision:8,minMove:.00000001}});
  const volume=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},1);
  const bars=aggregate(trades,period);series.setData(bars.map(b=>({...b,time:b.time as UTCTimestamp})));volume.setData(bars.map(b=>({time:b.time as UTCTimestamp,value:b.volume,color:b.close>=b.open?up:down})));
  const first=Math.max(0,bars.length-60),last=Math.max(48,bars.length+3);
  let alive=true,ranged=false;
  const fit=()=>{
   if(!alive||host.clientWidth<=0)return; // not laid out yet, e.g. the chart view is hidden on a phone
   const pane=chart.panes()[1],wanted=volumePaneHeight(host.clientHeight);if(pane&&Math.abs(pane.getHeight()-wanted)>1)pane.setHeight(wanted);
   if(!ranged){ranged=true;chart.timeScale().setVisibleLogicalRange({from:first-leftPadding(Math.max(120,host.clientWidth-90),last-first),to:last})}
  };
  fit();
  // The chart resizes itself to its container a little after the container changes, and pane heights scale with it.
  // So the volume pane is corrected on the next frame and again shortly afterwards, until it matches.
  let frame=0;const timers:ReturnType<typeof setTimeout>[]=[];
  const settle=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(fit);for(const t of timers.splice(0))clearTimeout(t);for(const delay of [80,250,600])timers.push(setTimeout(fit,delay))};
  const observer=new ResizeObserver(settle);observer.observe(host);settle();
  return()=>{alive=false;observer.disconnect();cancelAnimationFrame(frame);for(const t of timers)clearTimeout(t);chart.remove()};
 },[trades,period,mode]);
 return <figure ref={ref} className="g-chart-host" aria-label="Candlestick chart from actual testnet swaps. Times are UTC. Empty intervals are omitted."/>;
}
