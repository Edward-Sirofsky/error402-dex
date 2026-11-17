import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MarketChart} from './MarketChart';
import {marketHistory,readHistoryCache,saveHistoryCache,type Trade,type MarketHistory} from './market';
import {readPool,positionOf,withdrawal,checkWithdrawal,type PoolSnapshot} from './position';
import {checkDeposit} from './deposit';
import './approved-glass.css';
import {getAddress,encodeFunctionData,type Address,type Hex,type Abi,parseAbi} from 'viem';
import {transactionDeadline,client,guard,send,amount,balance,switchNetwork,formatUnits,erc20,routerAbi,pairAbi,minimumOutput,chainReader,releasesLock,TxError,type Connection,type Provider} from './wallet';
import {TESTNET_TREASURY,factoryAbi,ZKSYS,TUSD,EXPLORER,route,type Deployment} from '../../dex/src/shared';
import {QuoteBook,SLIPPAGE_BPS,approvalAmount,approvalRequired,swapCall,type ApprovalMode} from './quote-flow';
import {SwapDetails,PriceChange} from './SwapDetails';
import {readLocks,loadLocks,settleLock,dropLock,storeLock,lockFor,recover,explain,isFinal,submitWithLock,webLocks,stageLabels,dismissLabel,dismissNotice,LOCK_KEY,LEGACY_LOCK_KEY,type PendingRecord,type Resolution,type Stage,type TxKind} from './tx-lock';
import {Latest,Poller,freshness,freshnessText,tradeTime,networkNotice} from './refresh';
import manifest from '../../dex/deployments/zksys-testnet.json';

const deployment=manifest as Deployment;
const assets=[{symbol:'TSYS',decimals:18,address:undefined},{symbol:'ZKSYS',decimals:18,address:ZKSYS},{symbol:'tUSD',decimals:6,address:TUSD}];
const lpAbi=parseAbi(['function totalSupply() view returns (uint256)','function removeLiquidityETH(address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)']);
const ready=!!(deployment.router&&deployment.wrappedSYS&&deployment.pairZKSYS&&deployment.pairUSD&&deployment.factory&&deployment.protocolFeeRecipient?.toLowerCase()===TESTNET_TREASURY.toLowerCase());
// Refresh cadence for read-only data. Requests never overlap and stop while the tab is hidden.
const POOL_REFRESH_MS=30000,HISTORY_REFRESH_MS=60000,RECOVERY_REFRESH_MS=15000;
const STORAGE_BLOCKED='This browser is blocking site storage. error402 needs it to remember an open wallet request and prevent duplicate transactions, so nothing was sent. Allow site data for this page and reload.';
type Wallet={name:string;provider:Provider};
type Quote={path:Address[];input:bigint;output:bigint;impact:number;minimum:bigint;time:number;from:number;to:number;text:string};
const emptyTrades:Trade[]=[];
const short=(v:string)=>v.slice(0,8)+'…'+v.slice(-6);
// The theme and chart cache are conveniences: if storage is unavailable the page still works without them.
const remembered=(key:string)=>{try{return localStorage.getItem(key)}catch{return null}};
const remember=(key:string,value:string)=>{try{localStorage.setItem(key,value)}catch{}};
// Every write of the stored transaction records runs under one lock shared by all tabs of this site.
const store=storeLock();
// A display read: it never writes (any migration of old data runs under the lock, see loadLocks).
function storedLocks():{locks:PendingRecord[];ok:boolean}{try{return {locks:readLocks(localStorage,Date.now(),false),ok:true}}catch{return {locks:[],ok:false}}}

export function App(){
 const [mode,setMode]=useState<'light'|'dark'>(()=>remembered('error402-mode')==='dark'?'dark':'light');
 const [page,setPage]=useState<'trade'|'pools'|'agents'>('trade'),[market,setMarket]=useState<1|2>(1),[period,setPeriod]=useState(900);
 const [mobilePane,setMobilePane]=useState<'swap'|'chart'>('swap');
 const [clock,setClock]=useState(Date.now()),[chooser,setChooser]=useState(false);
 const [history,setHistory]=useState<MarketHistory>(),[historySaved,setHistorySaved]=useState(false),[historyFailed,setHistoryFailed]=useState(false),[historyLoading,setHistoryLoading]=useState(true);
 const [allowance,setAllowance]=useState(0n);
 const pair=market===1?deployment.pairZKSYS!:deployment.pairUSD!,selected=assets[market];
 useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer)},[]);

 const walletMenu=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!chooser)return;const outside=(e:PointerEvent)=>{if(!walletMenu.current?.contains(e.target as Node))setChooser(false)};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setChooser(false);walletMenu.current?.querySelector<HTMLButtonElement>('.g-connect')?.focus()}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);walletMenu.current?.querySelector<HTMLButtonElement>('.g-wallet-choice:not(:disabled)')?.focus();return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)}},[chooser]);
 const [wallets,setWallets]=useState<Wallet[]>([]),[connection,setConnection]=useState<Connection>();
 const [status,setStatus]=useState('Connect Pali or MetaMask to check your balances.'),[busy,setBusy]=useState(false);
 const locked=useRef(false);
 // One persisted record per open wallet request. `pending` is the record that blocks the connected account.
 const [initial]=useState(storedLocks);
 const [locks,setLocks]=useState<PendingRecord[]>(initial.locks),[storageOk,setStorageOk]=useState(initial.ok);
 const [resolutions,setResolutions]=useState<Record<string,Resolution>>({}),[stage,setStage]=useState<Stage>('idle');
 const pending=lockFor(locks,connection?.address??null);
 function syncLocks(){const next=storedLocks();setLocks(next.locks);setStorageOk(next.ok)}
 useEffect(()=>{loadLocks(store,localStorage).then(syncLocks,()=>setStorageOk(false))},[]); // migrate old or unreadable records once, under the lock
 const [from,setFrom]=useState(0),[to,setTo]=useState(1),[input,setInput]=useState('0.0001');
 const quoteBook=useRef(new QuoteBook<Quote>());
 const [quotes,setQuotes]=useState(()=>quoteBook.current.snapshot());
 const quote=quotes.latest;
 const [quoting,setQuoting]=useState(false),[quoteRetry,setQuoteRetry]=useState(0);
 const [approvalMode,setApprovalMode]=useState<ApprovalMode>('unlimited'),[customLimit,setCustomLimit]=useState(''),[approvalEdited,setApprovalEdited]=useState(false);
 const [step,setStep]=useState('');
 function clearQuote(){quoteBook.current.reset();setQuotes(quoteBook.current.snapshot());}
 function syncQuote(){setQuotes(quoteBook.current.snapshot());}
 const [balances,setBalances]=useState<string[]>([]),[pool,setPool]=useState<PoolSnapshot>();
 const [poolAt,setPoolAt]=useState<number>(),[poolLoading,setPoolLoading]=useState(false),[poolFailed,setPoolFailed]=useState(false);
 const [headTime,setHeadTime]=useState<number>(); // timestamp of the latest block, to notice a stalled network
 const [nativeDeposit,setNativeDeposit]=useState('0.0001'),[tokenDeposit,setTokenDeposit]=useState('');
 const [tx,setTx]=useState<Hex>(),[refresh,setRefresh]=useState(0),[fullRefresh,setFullRefresh]=useState(0);

 // Chart and recent trades: a saved copy may be shown first (display only), then the chain is read now and every
 // minute while the tab is visible. Only the newest request may publish; a failed read keeps the last good data.
 const historyPoller=useRef<Poller>(undefined),liveHistory=useRef<MarketHistory>(undefined);
 useEffect(()=>{
  const sequence=new Latest();liveHistory.current=undefined;
  const cached=readHistoryCache(pair,{getItem:remembered});
  setHistory(cached);setHistorySaved(!!cached);setHistoryFailed(false);setHistoryLoading(true);
  const load=async()=>{
   const ticket=sequence.begin();setHistoryLoading(true);
   try{
    const next=await marketHistory(pair,deployment.wrappedSYS!,selected.decimals,liveHistory.current);
    if(!sequence.isCurrent(ticket))return;
    liveHistory.current=next;setHistory(next);setHistorySaved(false);setHistoryFailed(false);saveHistoryCache(next,{setItem:remember});
   }catch{if(sequence.isCurrent(ticket))setHistoryFailed(true)}
   finally{if(sequence.isCurrent(ticket))setHistoryLoading(false)}
  };
  const poller=new Poller(load,HISTORY_REFRESH_MS,()=>document.hidden||locked.current);historyPoller.current=poller;poller.start();
  const visible=()=>poller.resume();document.addEventListener('visibilitychange',visible);
  return()=>{sequence.invalidate();poller.stop();historyPoller.current=undefined;document.removeEventListener('visibilitychange',visible)};
 },[pair,selected.decimals]);
 useEffect(()=>{if(refresh)historyPoller.current?.trigger()},[refresh]);
 useEffect(()=>{if(fullRefresh){liveHistory.current=undefined;historyPoller.current?.trigger()}},[fullRefresh]);

 useEffect(()=>{remember('error402-mode',mode)},[mode]);
 useEffect(()=>{
  const excluded=new Set<Provider>();
  const add=(name:string,provider:Provider)=>setWallets(old=>old.some(w=>w.name===name)?old:[...old.filter(w=>w.provider!==provider),{name,provider}]);
  const announce=(event:Event)=>{const d=(event as CustomEvent<{info:{name:string};provider:Provider}>).detail;if(typeof d?.provider?.request!=='function')return;const name=typeof d.info?.name==='string'?d.info.name.trim():'';if(/^pali( wallet)?$/i.test(name))add('Pali',d.provider);else if(/^metamask$/i.test(name))add('MetaMask',d.provider);else{excluded.add(d.provider);setWallets(old=>old.filter(w=>w.provider!==d.provider))}};
  window.addEventListener('eip6963:announceProvider',announce);window.dispatchEvent(new Event('eip6963:requestProvider'));
  type Injected=Provider&{providers?:Injected[];isMetaMask?:boolean;isPali?:boolean;isRabby?:boolean;isPhantom?:boolean;isTokenPocket?:boolean;isBraveWallet?:boolean;isCoinbaseWallet?:boolean};
  const legacy=window as unknown as {ethereum?:Injected;pali?:Provider};
  if(legacy.pali?.request)add('Pali',legacy.pali);
  for(const p of legacy.ethereum?.providers??(legacy.ethereum?[legacy.ethereum]:[])){if(excluded.has(p))continue;if(p.isPali)add('Pali',p);else if(p.isMetaMask&&!p.isRabby&&!p.isPhantom&&!p.isTokenPocket&&!p.isBraveWallet&&!p.isCoinbaseWallet)add('MetaMask',p);}
  return()=>window.removeEventListener('eip6963:announceProvider',announce);
 },[]);
 useEffect(()=>{clearQuote()},[from,to,input,connection]);
 useEffect(()=>{setAllowance(0n);setApprovalEdited(false)},[from,connection]);
 useEffect(()=>{
  const book=quoteBook.current;
  let cancelled=false,inFlight=false;
  if(!ready||page!=='trade'||busy||pending){setQuoting(false);return}
  try{amount(input,assets[from].decimals);if(from===to)return}catch{return}
  async function update(){
   if(cancelled||inFlight||document.hidden||locked.current)return;
   inFlight=true;setQuoting(true);const ticket=book.begin();
   try{const result=await fetchQuote();if(!cancelled&&!locked.current&&book.publish(ticket,result.quote)){setAllowance(result.allowance);syncQuote()}}
   catch(e){if(!cancelled&&!locked.current&&book.fail(ticket,(e as {shortMessage?:string}).shortMessage||(e as Error).message||'Price unavailable. Retrying automatically.'))syncQuote()}
   finally{inFlight=false;if(!cancelled)setQuoting(false)}
  }
  const start=setTimeout(()=>void update(),400),timer=setInterval(()=>void update(),10000);
  const visible=()=>{if(!document.hidden)void update()};document.addEventListener('visibilitychange',visible);
  return()=>{cancelled=true;book.cancel();clearTimeout(start);clearInterval(timer);document.removeEventListener('visibilitychange',visible)};
 },[from,to,input,connection,busy,!!pending,page,refresh,quoteRetry]);
 useEffect(()=>{
  if(!connection)return;
  const changed=()=>{clearQuote();setConnection(undefined);setBalances([]);setStatus('Wallet changed. Reconnect and review the amounts again.')};
  connection.provider.on?.('accountsChanged',changed);connection.provider.on?.('chainChanged',changed);
  return()=>{connection.provider.removeListener?.('accountsChanged',changed);connection.provider.removeListener?.('chainChanged',changed)};
 },[connection]);

 // Pool figures and wallet balances: read now and every 30 seconds while visible, with the same ordering guard.
 const poolPoller=useRef<Poller>(undefined),poolPair=useRef<Address>(undefined);
 useEffect(()=>{
  const sequence=new Latest();let reported='';
  if(poolPair.current!==pair){poolPair.current=pair;setPool(undefined);setPoolAt(undefined)} // keep pool figures on screen when only the wallet changed; the position is shown only for the account it was read for (positionOf)
  setPoolFailed(false);
  const load=async()=>{
   const ticket=sequence.begin();setPoolLoading(true);
   try{
    if(ready){
     try{
      // One block for every figure, tagged with the account it belongs to (see position.ts).
      const snapshot=await readPool(client,{pair,account:connection?.address??null,wrapped:deployment.wrappedSYS!,factory:deployment.factory!});
      if(!sequence.isCurrent(ticket))return;
      setPool(snapshot);setPoolAt(Date.now());setPoolFailed(false);setHeadTime(Number(snapshot.time));
     }catch{if(sequence.isCurrent(ticket))setPoolFailed(true)}
    }
    if(connection){
     try{
      await guard(connection);const b=await Promise.all(assets.map(a=>balance(connection.address,a.address)));
      if(!sequence.isCurrent(ticket))return;
      setBalances(b.map((v,i)=>formatUnits(v,assets[i].decimals)));reported='';
     }catch(e){
      // Say it once per distinct problem, so a repeating poll never overwrites a transaction result.
      const message=(e as {shortMessage?:string}).shortMessage??(e as Error).message??'Could not read wallet balances';
      if(sequence.isCurrent(ticket)&&message!==reported){reported=message;setStatus(message)}
     }
    }
   }finally{if(sequence.isCurrent(ticket))setPoolLoading(false)}
  };
  // No background reads while a wallet request is in flight: the wallet shares this RPC endpoint.
  const poller=new Poller(load,POOL_REFRESH_MS,()=>document.hidden||locked.current);poolPoller.current=poller;poller.start();
  const visible=()=>poller.resume();document.addEventListener('visibilitychange',visible);
  return()=>{sequence.invalidate();poller.stop();poolPoller.current=undefined;document.removeEventListener('visibilitychange',visible)};
 },[connection,pair]);
 useEffect(()=>{if(refresh||fullRefresh)poolPoller.current?.trigger()},[refresh,fullRefresh]);
 useEffect(()=>{if(tokenDeposit||!pool?.native)return;try{setTokenDeposit(formatUnits(amount(nativeDeposit,18)*pool.token/pool.native,selected.decimals))}catch{}},[pool,nativeDeposit,tokenDeposit,selected.decimals]);

 // Interrupted requests: another tab's changes are picked up at once, and every stored request is re-checked
 // against the chain now, every 15 seconds while visible, and on return to the tab. Nothing is ever resubmitted.
 useEffect(()=>{const onStorage=(e:StorageEvent)=>{if(e.key===null||e.key===LOCK_KEY||e.key===LEGACY_LOCK_KEY)syncLocks()};window.addEventListener('storage',onStorage);return()=>window.removeEventListener('storage',onStorage)},[]);
 const recovery=useRef<Promise<void>>(undefined),stopWaiting=useRef<()=>void>(undefined);
 function recoverLocks(manual=false):Promise<void>{
  if(recovery.current)return manual?recovery.current.then(()=>recoverLocks(true)):recovery.current;
  const work=(async()=>{
   let stored:PendingRecord[];
   try{stored=await loadLocks(store,localStorage)}catch{setStorageOk(false);return}
   for(const item of stored){
    try{
     const {record,resolution}=await recover(item,chainReader);
     // The check took time: apply its result only if the stored record is still the one that was checked. If it was
     // dismissed, settled in another tab or updated (e.g. a late hash from the wallet), the result is stale: drop it
     // and let the next check start from the stored record.
     if(isFinal(resolution)){
      if(!await settleLock(store,localStorage,item,null))continue;
      const result=explain(record,resolution);setStage(result.stage);setStatus(result.text);
      if('hash' in resolution)setTx(resolution.hash);
      setResolutions(old=>{const next={...old};delete next[item.id];return next});
      clearQuote();setRefresh(x=>x+1);
     }else{
      if(JSON.stringify(record)!==JSON.stringify(item)&&!await settleLock(store,localStorage,item,record))continue;
      setResolutions(old=>({...old,[item.id]:resolution}));
     }
    }catch{if(manual)setStatus('Could not reach the network to check this request. Nothing was changed; it will be checked again automatically.')}
   }
   syncLocks();
  })().finally(()=>{recovery.current=undefined});
  recovery.current=work;return work;
 }
 const hasLocks=locks.length>0;
 useEffect(()=>{
  if(!hasLocks||busy)return;
  const poller=new Poller(()=>recoverLocks(),RECOVERY_REFRESH_MS,()=>document.hidden);poller.start();
  const visible=()=>poller.resume();document.addEventListener('visibilitychange',visible);
  return()=>{poller.stop();document.removeEventListener('visibilitychange',visible)};
 },[hasLocks,busy]);
 async function dismiss(record:PendingRecord){
  try{await dropLock(store,localStorage,record.id)}catch{}
  setResolutions(old=>{const next={...old};delete next[record.id];return next});syncLocks();setStage('idle');
  setStatus(dismissNotice(record));
 }

 // Every action starts from a clean status, so a message from an earlier attempt can never sit beside a new request.
 async function run(fn:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setStage('idle');setTx(undefined);setStatus('Working on your request…');try{await fn()}catch(e){const error=e as {shortMessage?:string;message?:string};const said=error.shortMessage??error.message??'Request failed';
  // A failed check before the wallet opened: the router could not take a token from the wallet. Say so plainly.
  setStatus(/TRANSFER_FROM_FAILED/.test(said)?'The router could not take the token from your wallet: your balance or approved amount is lower than this request needs. Nothing was sent.':said)}finally{setBusy(false);locked.current=false;setRefresh(x=>x+1)}}
 async function checkFees(){if(!ready||!deployment.factory)throw new Error('Fee configuration is not confirmed');if((await client.readContract({address:deployment.factory,abi:factoryAbi,functionName:'feeTo'})).toLowerCase()!==TESTNET_TREASURY.toLowerCase())throw new Error('Protocol fee configuration changed. Trading paused; review the treasury.');}
 /**
  * Sends one wallet request. A record is stored before the wallet opens and is removed only when the outcome is
  * certain (confirmed, failed, rejected, cancelled, replaced or not sent). Anything else stays locked for recovery.
  */
 async function transact(kind:Exclude<TxKind,'legacy'>,label:string,address:Address,abi:Abi,fn:string,args:unknown[],value=0n,deadline:bigint|null=null,preserveQuote=false){
  if(!connection)throw new Error('Connect a wallet first');
  const account=connection.address;
  let storage:Storage;
  try{storage=localStorage;storage.getItem(LOCK_KEY)}catch{setStorageOk(false);throw new Error(STORAGE_BLOCKED)}
  // "Stop waiting" lets the user leave a wallet that has closed or is showing its own error. It never clears the
  // lock: the request is kept as uncertain (or pending, if a hash exists) and settled by the recovery checks.
  let sent:Hex|undefined;
  const stopped=new Promise<never>((_,reject)=>{stopWaiting.current=()=>reject(sent
   ?new TxError('TX_PENDING',`${label}: you stopped waiting. The transaction was already submitted and is still being followed below. Do not send it again.`,sent)
   :new TxError('TX_UNCERTAIN',`${label}: you stopped waiting for your wallet. This page will check whether anything was sent before unlocking.`))});
  try{
   await submitWithLock({storage,kind,label,account,to:address,data:encodeFunctionData({abi,functionName:fn,args}),value,deadline,mutex:webLocks(),store,
    position:async()=>{const [nonce,block]=await Promise.all([client.getTransactionCount({address:account,blockTag:'latest'}),client.getBlockNumber({cacheTime:0})]);return {nonce,block}},
    send:(onHash,beforeWallet)=>Promise.race([send(connection,address,abi,fn,args,hash=>{sent=hash;onHash(hash)},value,beforeWallet),stopped]),
    notify:(next,_record,hash)=>{
     syncLocks();setStage(next);if(hash)setTx(hash);
     if(next==='awaiting-wallet')setStatus(`${label}: confirm or reject the request in your wallet.`);
     if(next==='submitted'){setStep('Waiting for the network…');setStatus(`${label}: submitted. Waiting for the network. Do not send it again.`)}
    },
    // The wallet sent it after the user stopped waiting: it is tracked again (see Transaction status) and locks trading.
    late:()=>syncLocks()});
  }catch(e){
   syncLocks(); // shows a request opened in another tab, or the record kept for recovery
   if(releasesLock((e as {code?:string}).code)&&!preserveQuote)clearQuote();
   throw e;
  }finally{stopWaiting.current=undefined}
  syncLocks();if(!preserveQuote)clearQuote();
 }
 async function approval(token:Address,value:bigint,label:string){const allowed=await client.readContract({address:token,abi:erc20,functionName:'allowance',args:[connection!.address,deployment.router!]});if(allowed>=value)return true;await transact('approve',label,token,erc20,'approve',[deployment.router!,value]);setStatus('Exact allowance approved. Review again, then click the action to continue.');return false;}
 async function fetchQuote(){if(!ready)throw new Error('Testnet deployment is not yet confirmed');if(connection)await guard(connection);await checkFees();
  const blockNumber=await client.getBlockNumber({cacheTime:0});
  const value=amount(input,assets[from].decimals),path=route(assets[from].address??deployment.wrappedSYS!,assets[to].address??deployment.wrappedSYS!,deployment.wrappedSYS!);
  const out=await client.readContract({address:deployment.router!,abi:routerAbi,functionName:'getAmountsOut',blockNumber,args:[value,path]});const output=out.at(-1)!;
  let spot=value;
  for(let i=0;i<path.length-1;i++){const p=await client.readContract({address:deployment.factory!,abi:factoryAbi,functionName:'getPair',blockNumber,args:[path[i],path[i+1]]});const [res,t0]=await Promise.all([client.readContract({address:p,abi:pairAbi,functionName:'getReserves',blockNumber}),client.readContract({address:p,abi:pairAbi,functionName:'token0',blockNumber})]);const index=t0.toLowerCase()===path[i].toLowerCase()?0:1;if(!res[index])throw new Error('This pool has no liquidity');spot=spot*(index===0?res[1]:res[0])/(index===0?res[0]:res[1]);}
  const impact=spot>0n?Number((spot-output)*10000n/spot)/100:0;
  const allowance=connection&&assets[from].address?await client.readContract({address:assets[from].address!,abi:erc20,functionName:'allowance',args:[connection.address,deployment.router!]}):0n;
  return {allowance,quote:{input:value,output,impact,minimum:minimumOutput(output,SLIPPAGE_BPS),path,time:Date.now(),from,to,text:input}};
 }
 async function swap(){
  if(!connection||!quote)throw new Error('Wait for a price and connect your wallet.');
  if(quote.from!==from||quote.to!==to||quote.text!==input||Date.now()-quote.time>60000)throw new Error('Refreshing price. Please try again shortly.');
  if(quotes.needsAcceptance||quotes.minimum===undefined)throw new Error('Accept the updated price first.');
  // The minimum sent is exactly the "Minimum received" on screen at the moment of the click (the accepted floor). It is never lowered afterwards.
  const floor=quotes.minimum;
  quoteBook.current.cancel();setStep('Checking trade…');
  try{
   await guard(connection);
   const latest=await fetchQuote();
   if(latest.quote.impact>5)throw new Error('Reduce the amount: price difference exceeds 5% in this thin test pool.');
   const stillGood=quoteBook.current.confirm(floor,latest.quote);setAllowance(latest.allowance);syncQuote();
   if(!stillGood){setStatus('Price changed. Review and accept the updated amount before continuing.');return}
   const token=assets[from].address,symbols=`${input} ${assets[from].symbol} for ${assets[to].symbol}`;
   if(token){
    const target=approvalAmount(approvalMode,quote.input,customLimit,assets[from].decimals);
    if(approvalRequired(latest.allowance,quote.input,target,approvalEdited)){
     setStep('Approve in wallet…');setStatus(approvalMode==='unlimited'?`Confirm unlimited ${assets[from].symbol} spending for the error402 router in your wallet.`:'Confirm your chosen spending limit in your wallet.');
     await transact('approve',`Approve ${assets[from].symbol} spending`,token,erc20,'approve',[deployment.router!,target],0n,null,true);
     const actual=await client.readContract({address:token,abi:erc20,functionName:'allowance',args:[connection.address,deployment.router!]});
     setAllowance(actual);setApprovalEdited(false);
     setStatus(actual>=quote.input?'Spending approved. Updating price automatically; then choose Swap.':'The approved limit is below this trade. Adjust the amount or spending limit.');
     return;
    }
   }
   const deadline=transactionDeadline((await client.getBlock()).timestamp);
   setStep('Confirm swap in wallet…');
   const call=swapCall({fromNative:from===0,toNative:to===0,amountIn:quote.input,minimum:floor,path:quote.path,account:connection.address,deadline});
   await transact('swap',`Swap ${symbols}`,deployment.router!,routerAbi,call.functionName,[...call.args],call.value,deadline);
   setStatus('Swap confirmed on zkSYS testnet.');
  }finally{setStep('')}
 }
 async function addLiquidity(){
  if(!connection||!pool)throw new Error('Connect and load pool balances first');await checkFees();
  const native=amount(nativeDeposit,18),token=amount(tokenDeposit,selected.decimals);
  // Check the wallet can cover the deposit before asking for an approval or a simulation.
  const [nativeHave,tokenHave]=await Promise.all([balance(connection.address),balance(connection.address,selected.address!)]);
  checkDeposit(pool,native,token,{native:nativeHave,token:tokenHave},selected.decimals,selected.symbol);
  if(!await approval(selected.address!,token,`Approve ${selected.symbol} for liquidity`))return;
  const deadline=transactionDeadline((await client.getBlock()).timestamp);
  await transact('addLiquidity',`Add liquidity to TSYS / ${selected.symbol}`,deployment.router!,routerAbi,'addLiquidityETH',[selected.address!,token,minimumOutput(token,SLIPPAGE_BPS),minimumOutput(native,SLIPPAGE_BPS),connection.address,deadline],native,deadline);
  setStatus('Liquidity confirmed. LP tokens belong to your connected wallet.');
 }
 async function removeLiquidity(){
  if(!connection)throw new Error('Connect a wallet first');
  // Read this account's position again at one block. The minimums sent are the ones on screen, and only if the
  // current state still covers them; otherwise the new figures are shown for review (see checkWithdrawal).
  const fresh=await readPool(client,{pair,account:connection.address,wrapped:deployment.wrappedSYS!,factory:deployment.factory!});
  let plan:ReturnType<typeof checkWithdrawal>;
  try{plan=checkWithdrawal(position,fresh,connection.address,SLIPPAGE_BPS)}catch(e){setPool(fresh);setPoolAt(Date.now());throw e}
  if(!await approval(pair,plan.lp,`Approve TSYS / ${selected.symbol} LP tokens`))return;
  const deadline=transactionDeadline((await client.getBlock()).timestamp);
  await transact('removeLiquidity',`Remove liquidity from TSYS / ${selected.symbol}`,deployment.router!,lpAbi,'removeLiquidityETH',[selected.address!,plan.lp,plan.minToken,plan.minNative,connection.address,deadline],0n,deadline);
  setStatus('Your liquidity was removed and the assets returned to your wallet.');
 }
 // The connected account's position, only once it has been read for that account (never another wallet's figures).
 const position=positionOf(pool,connection?.address,pair);
 let exit:ReturnType<typeof withdrawal>|undefined;
 try{exit=position&&position.lp>0n?withdrawal(position,SLIPPAGE_BPS):undefined}catch{exit=undefined}
 const fmt=(n:bigint,d=18)=>Number(formatUnits(n,d)).toLocaleString('en-US',{maximumSignificantDigits:8});
 const currentQuote=!!quote&&quote.from===from&&quote.to===to&&quote.text===input;
 const expired=!!quote&&clock-quote.time>60000;
 let limit=0n,limitError='',inputError='';
 try{amount(input,assets[from].decimals)}catch(e){inputError=input.trim()?(e as Error).message:'Enter an amount.'}
 if(currentQuote&&assets[from].address)try{limit=approvalAmount(approvalMode,quote!.input,customLimit,assets[from].decimals)}catch(e){limitError=(e as Error).message}
 const needsApproval=currentQuote&&!!assets[from].address&&!limitError&&approvalRequired(allowance,quote!.input,limit,approvalEdited);
 const reason=busy?'Waiting for the current request…':pending?'An earlier request is still open. See Transaction status below.':!storageOk?STORAGE_BLOCKED:inputError||quotes.error||(!currentQuote?'Fetching price…':expired?'Price is stale. Refreshing automatically.':quote!.impact>5?'Reduce the amount: price difference exceeds 5%.':limitError||'');
 const acceptPrice=()=>{try{quoteBook.current.accept();syncQuote();setStatus('Updated price accepted. Review the minimum received, then swap.')}catch(e){setStatus((e as Error).message)}};
 const selectMarket=(id:1|2)=>{setMarket(id);setFrom(0);setTo(id);clearQuote();setPool(undefined);setPoolAt(undefined);setNativeDeposit('0.0001');setTokenDeposit('');};
 const setDeposit=(text:string)=>{setNativeDeposit(text);try{if(pool?.native){const desired=amount(text,18)*pool.token/pool.native;setTokenDeposit(formatUnits(desired,selected.decimals))}}catch{setTokenDeposit('')}};
 const price=pool?.token?Number(formatUnits(pool.native,18))/Number(formatUnits(pool.token,selected.decimals)):undefined;
 const trades=history?.pair===pair?history.trades:emptyTrades;
 const windowVolume=trades.reduce((sum,t)=>sum+t.native,0);
 const historyState=freshness({updatedAt:history?.updatedAt,loading:historyLoading,failed:historyFailed,saved:historySaved,now:clock,staleAfter:HISTORY_REFRESH_MS*2.5});
 const poolState=freshness({updatedAt:poolAt,loading:poolLoading,failed:poolFailed,now:clock,staleAfter:POOL_REFRESH_MS*2.5});
 const resolution=pending?resolutions[pending.id]:undefined;
 const stalled=networkNotice(headTime,clock);
 const external=(url:string,text:React.ReactNode,title?:string)=><a href={url} target="_blank" rel="noopener noreferrer" title={title}>{text}</a>;
 const connect=(w:Wallet)=>void run(async()=>{const accounts=await w.provider.request({method:'eth_requestAccounts'});if(!accounts[0])throw new Error('No account selected');setConnection({provider:w.provider,name:w.name,address:getAddress(accounts[0])});clearQuote();setChooser(false);setStatus('Wallet connected. Checking network and balances.');});
 return <div id="glass402"><div className={`g-app sapphire${mode==='light'?' daylight':''}`} data-page={page}>
  <header className="g-top"><div className="g-logo" aria-label="error402"><svg className="g-brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M6 8h11l-5 8h14M6 16h6l-5 8h19" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square"/></svg>error<em>402</em></div>
   <nav className="g-nav" aria-label="Main navigation">{(['trade','pools','agents'] as const).map(p=><button key={p} className={page===p?'chosen':''} aria-pressed={page===p} onClick={()=>setPage(p)}>{p[0].toUpperCase()+p.slice(1)}</button>)}</nav>
   <div className="g-network"><i/>zkSYS testnet · 57057</div><div className="g-header-actions"><label className="g-theme-toggle"><span>{mode==='light'?'Light mode':'Dark mode'}</span><input type="checkbox" role="switch" aria-label="Dark mode" checked={mode==='dark'} onChange={e=>setMode(e.target.checked?'dark':'light')}/></label>
   <div className="g-wallet-control" ref={walletMenu}><button className="g-connect" disabled={busy} onClick={()=>setChooser(!chooser)} aria-expanded={chooser} aria-haspopup="dialog" aria-controls="wallet-chooser">{connection?short(connection.address):'Connect wallet'}</button>
    {chooser&&<section id="wallet-chooser" className="g-wallet-picker" role="dialog" aria-label="Connect wallet"><div className="g-wallet-heading"><strong>Connect your wallet</strong><button className="g-wallet-close" aria-label="Close wallet chooser" onClick={()=>setChooser(false)}>×</button></div><p className="g-wallet-subtitle">Choose Pali or MetaMask</p><div className="g-wallet-options">{(['Pali','MetaMask'] as const).map(name=>{const w=wallets.find(w=>w.name===name);return <button className="g-wallet-choice" key={name} disabled={busy||!w} onClick={()=>w&&connect(w)}><span className="g-wallet-icon" aria-hidden="true">{name==='Pali'?'P':'M'}</span><span><strong>{name}</strong><small>{w?'Connect with '+name:'Not detected in this browser'}</small></span><span aria-hidden="true">↗</span></button>})}</div>{!wallets.length&&<p className="g-fine">Use a browser with Pali or MetaMask installed. On mobile, open this site in your wallet’s built-in browser.</p>}{connection&&<div className="g-wallet-manage"><small>{connection.name} · {short(connection.address)}</small><button className="g-secondary" disabled={busy} onClick={()=>void run(()=>switchNetwork(connection.provider))}>Switch to zkSYS testnet</button><button className="g-secondary" disabled={busy} onClick={()=>{setConnection(undefined);clearQuote();setBalances([]);setChooser(false)}}>Disconnect</button></div>}</section>}
   </div></div>
  </header>
  <div className="g-eyebrow"><span className="finish">Midnight Blue / glass edition</span><span>Testnet beta · Test assets only · Experimental contracts</span></div>
  {page==='trade'&&<div className={`g-layout mobile-${mobilePane}`}>
   <aside className="g-markets" aria-label="Markets"><p className="g-label">Markets</p>{([1,2] as const).map(i=><button className="market" key={i} aria-pressed={market===i} disabled={busy} onClick={()=>selectMarket(i)}><span className="coin">{i===1?'Z':'$'}</span><span><strong>{assets[i].symbol}</strong><small>Pair with TSYS</small></span></button>)}<div className="g-marketfoot">Your wallet.<br/>Your next move.<p>{external('https://faucet-zk.tanenbaum.io/','Get test gas ↗')}</p></div></aside>
   <div className="g-mobile-switch" aria-label="Trade view"><button aria-pressed={mobilePane==='swap'} onClick={()=>setMobilePane('swap')}>Swap</button><button aria-pressed={mobilePane==='chart'} onClick={()=>setMobilePane('chart')}>Chart &amp; trades</button></div>
   <main className="g-center"><div className="g-pair"><div><h2>{selected.symbol} <span className="muted">/ TSYS</span></h2><small>Spot · {freshnessText('On-chain pool',poolState,poolAt)}</small></div><div className="g-price"><strong>{price?.toPrecision(6)??'—'}</strong><small>TSYS per {selected.symbol}</small></div></div>
    <div className="g-metrics"><div><label>Pool reserve / TSYS</label><strong>{pool?fmt(pool.native):'—'}</strong></div><div><label>Indexed volume / TSYS</label><strong>{history?windowVolume.toPrecision(5):'—'}</strong></div><div><label>Buys / sells · indexed</label><strong>{history?`${trades.filter(t=>t.side==='Buy').length} / ${trades.filter(t=>t.side==='Sell').length}`:'—'}</strong></div></div>
    <div className="g-chart"><div className="g-chart-top"><span>Price / TSYS · UTC</span><div className="g-periods" aria-label="Candle interval">{[[900,'15m'],[3600,'1h'],[14400,'4h']].map(([v,label])=><button key={v} aria-pressed={period===v} onClick={()=>setPeriod(Number(v))}>{label}</button>)}</div></div>
     <MarketChart trades={trades} period={period} mode={mode}/>
     <p className="g-data-note">{freshnessText('Chart and trades',historyState,history?.updatedAt)}{history&&!trades.length&&historyState!=='saved'?' · no swaps in this window yet':''}</p>
     {history&&<p className="g-data-note">{history.truncated?'Latest 200 swaps only':`${trades.length} swap${trades.length===1?'':'s'}`} · blocks {String(history.fromBlock)}–{String(history.toBlock)} · times in UTC. Empty intervals are omitted; these are not 24-hour totals.</p>}

     <div className="g-attribution"><span>Volume / TSYS</span>{external('https://www.tradingview.com/','TradingView Lightweight Charts™')}</div>
    </div>
    <section className="g-trades"><div className="g-trades-head"><strong>Recent trades</strong><span className="muted">On-chain activity</span></div><table aria-label="Recent pool trades"><thead><tr><th>Side</th><th>Price / TSYS</th><th>{selected.symbol}</th><th>Time (UTC)</th></tr></thead><tbody>{trades.slice(-8).reverse().map(t=><tr key={t.hash+':'+t.index}><td className={t.side==='Buy'?'up':'down'}>{t.side==='Buy'?'↗ Buy':'↘ Sell'}</td><td>{t.price.toPrecision(5)}</td><td>{t.tokens.toPrecision(5)}</td><td>{external(`${EXPLORER}/tx/${t.hash}`,tradeTime(t.time,clock),new Date(t.time*1000).toISOString().replace('T',' ').slice(0,19)+' UTC')}</td></tr>)}</tbody></table></section>
   </main>
   <aside className="g-ticket" aria-label="Swap test tokens"><div className="g-ticketheading"><h3>Swap</h3><span>Spot market</span></div><div className="g-sides"><button aria-pressed={from===0&&to===market} disabled={busy} onClick={()=>{setFrom(0);setTo(market)}}>Buy {selected.symbol}</button><button aria-pressed={from===market&&to===0} disabled={busy} onClick={()=>{setFrom(market);setTo(0)}}>Sell {selected.symbol}</button></div>
    <div className="g-fields"><div className="g-field"><label htmlFor="swap-amount">You pay</label><div className="g-amountrow"><input id="swap-amount" inputMode="decimal" autoComplete="off" value={input} disabled={busy} onChange={e=>{setInput(e.target.value);if(approvalMode==='exact')setApprovalEdited(true)}}/><select className="g-currency" aria-label="Pay token" value={from} disabled={busy} onChange={e=>{const i=Number(e.target.value);setFrom(i);if(to===i)setTo((i+1)%3)}}>{assets.map((a,i)=><option key={i} value={i}>{a.symbol}</option>)}</select></div><small>Balance: {balances[from]??'Connect wallet'}</small></div>
    <button className="g-downarrow" aria-label="Reverse swap direction" disabled={busy} onClick={()=>{setFrom(to);setTo(from)}}>↓</button>
    <div className="g-field"><label>You receive</label><div className="g-amountrow"><output title={quote?formatUnits(quote.output,assets[to].decimals):undefined}>{quote?Number(formatUnits(quote.output,assets[to].decimals)).toLocaleString('en-US',{maximumSignificantDigits:6}):'—'}</output><select className="g-currency" aria-label="Receive token" value={to} disabled={busy} onChange={e=>setTo(Number(e.target.value))}>{assets.map((a,i)=>i!==from&&<option key={i} value={i}>{a.symbol}</option>)}</select></div><small>Balance: {balances[to]??'Connect wallet'}</small></div></div>
    <SwapDetails book={quotes} current={currentQuote} decimals={assets[to].decimals} symbol={assets[to].symbol} quoting={quoting} expired={expired}/>
    {!!assets[from].address&&<details className="g-approval-settings"><summary>Approval limit: {approvalMode==='unlimited'?'Unlimited':approvalMode==='exact'?'This trade only':'Custom'}</summary><label htmlFor="approval-limit">Allow error402 to spend</label><select id="approval-limit" disabled={busy||!!pending} value={approvalMode} onChange={e=>{setApprovalMode(e.target.value as ApprovalMode);setApprovalEdited(true)}}><option value="unlimited">Unlimited</option><option value="exact">This trade only</option><option value="custom">Custom amount</option></select>{approvalMode==='custom'&&<label>Limit in {assets[from].symbol}<input aria-label="Custom spending limit" inputMode="decimal" autoComplete="off" disabled={busy||!!pending} value={customLimit} onChange={e=>{setCustomLimit(e.target.value);setApprovalEdited(true)}}/></label>}<p>{approvalMode==='unlimited'?`Unlimited permission covers future ${assets[from].symbol} trades until you change or revoke it.`:'Only your chosen amount will be approved.'} Each swap still needs your wallet confirmation.</p><p>Current allowance: {connection?(allowance===approvalAmount('unlimited',0n,'',18)?'Unlimited':fmt(allowance,assets[from].decimals)):'Connect wallet'}. Changes take effect after wallet confirmation.</p>{external(`${EXPLORER}/address/${deployment.router}`,'View approved router ↗')}</details>}
    <PriceChange book={quotes} current={currentQuote} decimals={assets[to].decimals} symbol={assets[to].symbol}/>
    <button className="g-action g-swap-submit" disabled={busy||!!pending||!ready||(!!connection&&!!reason)} onClick={()=>{if(!connection){setChooser(true);return}if(quotes.needsAcceptance){acceptPrice();return}void run(swap)}}>{busy?(step||'Please wait…'):!connection?'Connect wallet':quotes.needsAcceptance?'Accept updated price':needsApproval?(allowance>=quote!.input?'Update spending limit':`Approve ${assets[from].symbol}`):'Swap'}</button>
    {quotes.error&&<button className="g-secondary" disabled={busy||!!pending} onClick={()=>setQuoteRetry(x=>x+1)}>Retry connection</button>}
    <p className="g-fine" aria-live="polite">{reason||(!connection?'Connect Pali or MetaMask to trade.':quotes.needsAcceptance?'Nothing is sent until you accept the new price.':needsApproval?(approvalMode==='unlimited'?`Approve unlimited ${assets[from].symbol} spending once, then swap. You can edit the limit above.`:'Confirm your chosen spending limit, then swap.'):'Review and confirm the swap in your wallet. The minimum received shown above is the amount sent with it.')}{stalled&&!busy&&!reason?' Note: the network is not producing blocks right now — see Transaction status.':''}</p><details className="g-fee-explanation"><summary>Fee breakdown &amp; network gas</summary><p className="g-fine">Fees included: approx. 0.25% to LPs + 0.05% to error402 per pool. Two-pool routes pay both fees. Gas is separate.</p></details>
   </aside>
  </div>}
  {page==='pools'&&<section className="g-section"><div className="g-section-head"><div><p className="g-kicker">Liquidity</p><h2>Your liquidity, working for the pool.</h2><p>Supply both assets. Earn LP fees in proportion to your share.</p></div><span className="g-status">Testnet pools</span></div><div className="g-pools-layout"><div><div className="g-pool-columns"><span>Pool</span><span>Fee</span><span>Network</span></div>{([1,2] as const).map(i=><button className="g-pool-row" key={i} aria-pressed={market===i} disabled={busy} onClick={()=>selectMarket(i)}><span className="g-pool-pair"><span className="g-token-stack"><b>T</b><b>{i===1?'Z':'$'}</b></span><span><strong>TSYS / {assets[i].symbol}</strong><small>{i===1?'Native TSYS + existing ZKSYS':'Native TSYS + test dollar'}</small></span></span><span className="g-pool-value">0.30%</span><span className="g-pool-state">Testnet ↗</span></button>)}
    <div className="g-position"><p className="g-kicker">Your position · TSYS / {selected.symbol}</p><h3>{!connection?'Connect to see your position':position?`${fmt(position.lp)} LP tokens`:'Loading your position…'}</h3>{exit&&<p>Withdrawing now returns about {fmt(exit.native)} TSYS + {fmt(exit.token,selected.decimals)} {selected.symbol}. Minimum sent with it: {fmt(exit.minNative)} TSYS + {fmt(exit.minToken,selected.decimals)} {selected.symbol}.</p>}<p>Pool: {pool?`${fmt(pool.native)} TSYS + ${fmt(pool.token,selected.decimals)} ${selected.symbol}`:'Loading…'}</p><p className="g-fine">{freshnessText('Pool figures',poolState,poolAt)}</p><p>Creating a pool gives no extra fee entitlement. Protocol fees mint LP shares to the treasury. Withdrawals return your share of the current reserves, which may differ from your deposit.</p>{external(`${EXPLORER}/address/${pair}`,'View pool contract ↗')}</div></div>
    <aside className="g-pool-detail"><h3>TSYS / {selected.symbol}</h3><p className="g-pool-description">Add both assets at the current ratio.</p><div className="g-field"><label htmlFor="deposit-native">TSYS to deposit</label><div className="g-amountrow"><input id="deposit-native" inputMode="decimal" autoComplete="off" disabled={busy} value={nativeDeposit} onChange={e=>setDeposit(e.target.value)}/></div></div><div className="g-field"><label htmlFor="deposit-token">{selected.symbol} to deposit</label><div className="g-amountrow"><input id="deposit-token" inputMode="decimal" autoComplete="off" disabled={busy} value={tokenDeposit} onChange={e=>setTokenDeposit(e.target.value)}/></div></div><p className="g-fine">Changing TSYS fills the matching token amount. Minimum amounts allow 0.5% variation.{connection&&balances.length>Math.max(0,market)?` Your wallet: ${Number(balances[0]).toLocaleString('en-US',{maximumSignificantDigits:6})} TSYS · ${Number(balances[market]).toLocaleString('en-US',{maximumSignificantDigits:6})} ${selected.symbol}.`:''}</p><button className="g-action" disabled={busy||!connection||!pool||!!pending||!storageOk} onClick={()=>void run(addLiquidity)}>Approve token / add liquidity</button><button className="g-secondary" disabled={busy||!connection||!position?.lp||!!pending||!storageOk} onClick={()=>void run(removeLiquidity)}>Approve LP / remove my position</button><p className="g-fine">If approval is requested, confirm it first, then click again to deposit or withdraw. Removal returns your entire position; the minimum shown is sent with it.</p></aside>
   </div></section>}
  {page==='agents'&&<section className="g-section g-agent-section"><div className="g-agent-heading"><p className="g-kicker">Built for what comes next</p><h2>A home for your agents.</h2><p>Choose how you want to connect. Agent access is on the way.</p></div><div className="g-agent-options">{[['Claude Code','✳','Your coding companion.'],['Codex','>_','From intent to execution.'],['Personal agent','{ }','Your agent, your workflow.']].map(([name,mark,desc])=><div className="g-agent-option" key={name}><div className="g-agent-bubble" aria-hidden="true"><span className={`g-agent-glyph${name==='Codex'?' g-agent-terminal':name==='Personal agent'?' g-agent-personal':''}`}>{mark}</span></div><h3>{name}</h3><p>{desc}</p><span className="g-coming">Coming soon</span></div>)}</div><div className="g-agent-foot"><span className="g-agent-dot"/>No agent connections or trading permissions are enabled.</div></section>}
  <section className="g-transaction" aria-label="Transaction status" aria-live="polite"><strong>Transaction status{pending&&!busy?` · ${stageLabels[explain(pending,resolution).stage]}`:stage!=='idle'?` · ${stageLabels[stage]}`:''}</strong>
   {pending&&!busy?<><p>{explain(pending,resolution).text}</p><p>Trading stays locked meanwhile so nothing is sent twice. Nothing is re-sent automatically.</p>{pending.hash&&external(`${EXPLORER}/tx/${pending.hash}`,'View this transaction ↗')}<button className="g-connect" onClick={()=>void run(()=>recoverLocks(true))}>Check status now</button>{resolution&&!isFinal(resolution)&&resolution.dismissible&&<button className="g-secondary" onClick={()=>dismiss(pending)}>{dismissLabel(pending)}</button>}</>:<><p>{status}</p>{tx&&external(`${EXPLORER}/tx/${tx}`,'View transaction ↗')}{busy&&(stage==='awaiting-wallet'||stage==='submitted')&&<button className="g-secondary" onClick={()=>stopWaiting.current?.()}>Wallet closed or showing an error? Stop waiting</button>}</>}
   {stalled&&<p role="status">{stalled}</p>}
   {!storageOk&&<p>{STORAGE_BLOCKED}</p>}
  </section>
  <footer className="g-footer"><button className="g-connect" disabled={busy} onClick={()=>{setFullRefresh(x=>x+1)}}>Refresh data</button>{external(`${EXPLORER}/address/${TESTNET_TREASURY}`,'Fee treasury')}{external(`${EXPLORER}/token/${ZKSYS}`,'ZKSYS contract')}{external(`${EXPLORER}/token/${TUSD}`,'tUSD contract')}<span>error402 · zkSYS testnet beta · Test assets only</span></footer>
 </div></div>;
}
// Mounted only when the page has its root element, so tests can import and render <App/> on their own.
const root=typeof document==='undefined'?null:document.getElementById('root');
if(root)createRoot(root).render(<App/>);
