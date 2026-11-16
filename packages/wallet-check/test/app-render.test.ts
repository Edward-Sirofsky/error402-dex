// Renders the real page component (<App/> from main.tsx) with react-dom/server. This covers the FIRST render only —
// effects, polling and clicks do not run without a DOM library (not installed). It checks the wiring that decides
// what a visitor first sees: stored locks, the recovery panel, the disabled actions and the swap ticket.
// No network request is made during a server render. SIMULATED storage only.
import {beforeEach,describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LEGACY_LOCK_KEY,LOCK_KEY,newRecord} from '../src/tx-lock';

const memory=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)},map}};
let storage:ReturnType<typeof memory>|{getItem:()=>never;setItem:()=>never;removeItem:()=>never};
Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage});
const {App}=await import('../src/main');
const page=()=>renderToStaticMarkup(createElement(App));
const text=(html:string)=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const swapButton=(html:string)=>/<button class="g-action g-swap-submit"([^>]*)>/.exec(html)?.[1]??'';
beforeEach(()=>{storage=memory()});

describe('first render of the page',()=>{
 it('with no stored request: trading is not locked and the swap ticket comes from SwapDetails',()=>{
  const html=page();
  expect(text(html)).not.toMatch(/Trading stays locked/);expect(swapButton(html)).not.toMatch(/disabled/);
  expect(text(html)).toMatch(/Slippage limit 0\.50%/);expect(text(html)).toMatch(/Minimum received — ZKSYS/);
 });
 it('with a request left by the old version: locked at once, never "expired", with the recovery controls',()=>{
  (storage as ReturnType<typeof memory>).setItem(LEGACY_LOCK_KEY,'unknown');const html=page();
  expect(text(html)).toMatch(/Transaction status · Outcome not yet known/);
  expect(text(html)).toMatch(/An earlier request from this browser: a wallet request was open\. Checking what happened/);
  expect(text(html)).toMatch(/Trading stays locked meanwhile so nothing is sent twice/);expect(text(html)).toMatch(/Check status now/);
  expect(swapButton(html)).toMatch(/disabled/);expect(text(html)).not.toMatch(/Expired/);
  const [migrated]=JSON.parse((storage as ReturnType<typeof memory>).getItem(LOCK_KEY)!);expect(migrated).toMatchObject({kind:'legacy',deadline:null});
 });
 it('with corrupt lock data: treated as a lock, never as "no lock"',()=>{
  (storage as ReturnType<typeof memory>).setItem(LOCK_KEY,'{not json');const html=page();
  expect(swapButton(html)).toMatch(/disabled/);expect(text(html)).toMatch(/Trading stays locked/);
 });
 it('with an open swap from this version: shown by its own label and locked',()=>{
  const r=newRecord({kind:'swap',label:'Swap 0.0001 TSYS for ZKSYS',account:'0x00000000000000000000000000000000000000a1',to:'0x00000000000000000000000000000000000000c3',data:'0x12345678',value:1n,deadline:1_800_001_200n,nonce:8,block:100n});
  (storage as ReturnType<typeof memory>).setItem(LOCK_KEY,JSON.stringify([r]));const html=page();
  expect(text(html)).toMatch(/Transaction status · Waiting for your wallet/);expect(text(html)).toMatch(/Swap 0\.0001 TSYS for ZKSYS: a wallet request was open/);expect(swapButton(html)).toMatch(/disabled/);
 });
 it('with site storage blocked: the page still renders and says why trading is refused',()=>{
  storage={getItem:()=>{throw new Error('blocked')},setItem:()=>{throw new Error('blocked')},removeItem:()=>{throw new Error('blocked')}};
  expect(text(page())).toMatch(/This browser is blocking site storage/);
 });
});
