// Cross-tab exclusion for wallet requests (audit F-9, residual: "two tabs clicking within the same few
// milliseconds could both open the wallet"). Uses Node's own Web Locks API (navigator.locks), the same API
// the page uses in the browser. SIMULATED wallet: no network, no signature.
import {describe,it,expect,vi} from 'vitest';
import {submitWithLock,webLocks,walletLockName,readLocks,type SubmitInput} from '../src/tx-lock';

const user='0x00000000000000000000000000000000000000a1' as const,other='0x00000000000000000000000000000000000000b2' as const,router='0x00000000000000000000000000000000000000c3' as const;
const h=(n:number)=>('0x'+n.toString(16).padStart(64,'0')) as `0x${string}`;
const memory=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)},map}};
/** A wallet prompt that stays open until `confirm` is called. */
function openPrompt(){let confirm!:()=>void;const opened=vi.fn();const send:SubmitInput['send']=(onHash,before)=>new Promise<void>(resolve=>{before();opened();confirm=()=>{onHash(h(1));resolve()}});return {send,opened,confirm:()=>confirm()}}
const request=(storage:ReturnType<typeof memory>,send:SubmitInput['send'],over:Partial<SubmitInput>={})=>submitWithLock({storage,kind:'swap',label:'Swap',account:user,to:router,data:'0x12345678',value:1n,deadline:1_800_001_200n,position:async()=>({nonce:8,block:100n}),send,mutex:webLocks(),...over});
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve()};

describe('one wallet request per account across tabs',()=>{
 it('this runtime provides the Web Locks API the page relies on',()=>expect(webLocks()).toBeTypeOf('function'));
 it('two tabs clicking at the same instant: the second is refused before anything is stored or the wallet opens',async()=>{
  // Separate storage views model two tabs before the first tab's write has reached the second (localStorage is not
  // a transaction). Without the Web Lock both would pass their storage checks.
  const tabA=memory(),tabB=memory(),a=openPrompt(),b=openPrompt();
  const first=request(tabA,a.send);await flush();
  await expect(request(tabB,b.send)).rejects.toMatchObject({code:'TX_LOCKED'});
  expect(b.opened).not.toHaveBeenCalled();expect(readLocks(tabB)).toEqual([]);expect(a.opened).toHaveBeenCalledTimes(1);
  a.confirm();await first;
 });
 it('control: without the Web Lock, the same race opens two wallet prompts',async()=>{
  const tabA=memory(),tabB=memory(),a=openPrompt(),b=openPrompt();
  void request(tabA,a.send,{mutex:undefined});void request(tabB,b.send,{mutex:undefined});await flush();
  expect(a.opened).toHaveBeenCalledTimes(1);expect(b.opened).toHaveBeenCalledTimes(1);a.confirm();b.confirm();
 });
 it('another account is not blocked',async()=>{
  const a=openPrompt(),b=openPrompt();const first=request(memory(),a.send);await flush();
  const second=request(memory(),b.send,{account:other});await flush();expect(b.opened).toHaveBeenCalledTimes(1);
  a.confirm();b.confirm();await Promise.all([first,second]);
 });
 it('the lock is released when the request settles, so the next request can start',async()=>{
  const s=memory(),a=openPrompt();const first=request(s,a.send);await flush();a.confirm();await first;
  const b=openPrompt();const second=request(s,b.send);await flush();expect(b.opened).toHaveBeenCalledTimes(1);b.confirm();await second;
 });
 it('after "Stop waiting" the Web Lock is released but the stored record still blocks the account',async()=>{
  const s=memory();await expect(request(s,async(_h,before)=>{before();throw Object.assign(new Error('stopped'),{code:'TX_UNCERTAIN'})})).rejects.toMatchObject({code:'TX_UNCERTAIN'});
  const b=openPrompt();await expect(request(s,b.send)).rejects.toMatchObject({code:'TX_LOCKED'});expect(b.opened).not.toHaveBeenCalled();
 });
 it('falls back to the storage re-check where the API is missing',()=>{expect(webLocks(null)).toBeUndefined();expect(webLocks({} as never)).toBeUndefined()});
 it('lock names are per account and case-insensitive',()=>expect(walletLockName('0x00000000000000000000000000000000000000A1' as `0x${string}`)).toBe(walletLockName(user)));
});
