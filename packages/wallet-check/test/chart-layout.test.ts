// Remediation of the clipped TradingView mark: the library draws its 35x19 attribution mark 10px inside the
// bottom (volume) pane, so that pane must always be tall enough for it and the first bars must not start under it.
// Pure sizing rules only; how it looks in a browser has to be checked visually.
import {describe,it,expect,vi} from 'vitest';
vi.mock('lightweight-charts',()=>({createChart:vi.fn(),CandlestickSeries:{},HistogramSeries:{},ColorType:{Solid:'solid'}}));
import {volumePaneHeight,leftPadding} from '../src/MarketChart';

const LOGO_HEIGHT=19,LOGO_WIDTH=35,INSET=10;
describe('volume pane is always tall enough for the whole attribution mark',()=>{
 it('never shorter than the mark plus its insets, at any chart height',()=>{for(let h=0;h<=1200;h+=7)expect(volumePaneHeight(h)).toBeGreaterThanOrEqual(LOGO_HEIGHT+INSET*2)});
 it('covers the compact desktop chart that used to clip it (172px chart gave a 28px pane)',()=>{expect(volumePaneHeight(172)).toBeGreaterThanOrEqual(39);expect(volumePaneHeight(132)).toBeGreaterThanOrEqual(39)});
 it('stays about a fifth of a normal chart and is capped on tall ones',()=>{expect(volumePaneHeight(320)).toBe(64);expect(volumePaneHeight(350)).toBe(70);expect(volumePaneHeight(680)).toBe(72)});
 it('leaves most of a short chart to prices',()=>expect(volumePaneHeight(172)).toBeLessThan(172/3));
});
describe('first bars do not start underneath the mark',()=>{
 const clear=LOGO_WIDTH+INSET*2;
 it('keeps at least the width of the mark free at the left, on wide and narrow charts',()=>{for(const plot of [190,280,360,660,1200]){const span=51,pad=leftPadding(plot,span);expect(pad*plot/(span+pad)).toBeGreaterThanOrEqual(clear-0.5)}});
 it('uses only a few empty slots on a wide chart',()=>expect(leftPadding(660,51)).toBeLessThanOrEqual(6));
 it('falls back to a small padding when the chart is too narrow to clear the mark',()=>expect(leftPadding(90,51)).toBe(2));
});
