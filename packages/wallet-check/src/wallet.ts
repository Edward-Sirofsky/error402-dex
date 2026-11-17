import {createPublicClient,createWalletClient,custom,http,getAddress,parseUnits,formatUnits,type Address,type Hex,type EIP1193Provider,type Abi,type TransactionReceipt} from 'viem';
import {chain,RPC,erc20,routerAbi,pairAbi,minimumOutput,assertTestnet} from '../../dex/src/shared';
import type {ChainReader,ChainTx} from './tx-lock';
export {chain,erc20,routerAbi,pairAbi,minimumOutput,formatUnits};
export const client=createPublicClient({chain,transport:http(RPC,{timeout:15000})});
export type Provider=Pick<EIP1193Provider,'request'> & {on?:(event:string,fn:()=>void)=>void;removeListener?:(event:string,fn:()=>void)=>void};
export interface Connection{provider:Provider;address:Address;name:string}

/**
 * Turns what a person typed into an exact decimal string. Accepts 12, 12.5, .5 and a decimal comma (0,5).
 * Rejects signs, exponents, spaces inside the number, more than one separator, and a comma that could be a
 * thousands separator (1,000). Works on text only: no floating-point number is ever involved.
 */
export function normalizeAmount(text:string):{whole:string;fraction:string}{
 const t=text.trim();
 if(!t)throw new Error('Enter an amount.');
 if(!/^(\d+([.,]\d+)?|[.,]\d+)$/.test(t))throw new Error('Enter a plain number such as 0.5 or 0,5 (digits with one decimal point or comma).');
 const comma=t.includes(','),[whole='',fraction='']=t.split(comma?',':'.');
 if(comma&&fraction.length===3&&/^[1-9]\d{0,2}$/.test(whole))throw new Error(`"${t}" could mean ${whole}.${fraction} or ${whole}${fraction}. Type it with a decimal point, for example ${whole}.${fraction}`);
 return {whole:whole||'0',fraction};
}
export function amount(text:string,decimals:number){
 const {whole,fraction}=normalizeAmount(text);
 if(fraction.length>decimals)throw new Error(`Too many decimal places: this token allows ${decimals}.`);
 const n=parseUnits(fraction?`${whole}.${fraction}`:whole,decimals);if(n<=0n)throw new Error('Amount must be greater than zero');return n;
}
export async function guard(c:Connection){
 const id=await c.provider.request({method:'eth_chainId'});
 if(Number(id)!==chain.id)throw new Error('Switch this wallet to zkSYS Testnet (57057)');
 const accounts=await c.provider.request({method:'eth_accounts'});
 if(!accounts[0]||getAddress(accounts[0])!==getAddress(c.address))throw new Error('Wallet account changed. Reconnect and review again.');
 await assertTestnet(client);
}
export async function switchNetwork(provider:Provider){
 try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0xdee1'}]});}
 catch(e){if((e as {code?:number}).code!==4902)throw e;
 await provider.request({method:'wallet_addEthereumChain',params:[{chainId:'0xdee1',chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:[RPC],blockExplorerUrls:[chain.blockExplorers.default.url]}]});}
}

export type TxErrorCode='TX_REJECTED'|'TX_NOT_SENT'|'TX_UNCERTAIN'|'TX_PENDING'|'TX_REVERTED'|'TX_CANCELLED'|'TX_REPLACED';
export class TxError extends Error{constructor(public code:TxErrorCode,message:string,public hash?:Hex){super(message)}}
/**
 * The wallet's own words about a failure, as one short line of plain text, or '' if it said nothing useful.
 * Shown next to this page's explanation so the two never contradict each other (for example Pali's
 * "Can't complete transaction"). It is only ever rendered as text.
 */
export function walletSaid(error:unknown):string{
 let text='',cause:unknown=error;
 for(let i=0;i<8&&cause;i++){
  const detail=cause as {details?:unknown;message?:unknown;cause?:unknown;data?:{message?:unknown}};
  // The innermost message is the wallet's; outer ones are library wrappers. `details` is where viem keeps the original.
  const here=[detail.data?.message,detail.details,detail.cause?undefined:detail.message].find(candidate=>typeof candidate==='string'&&candidate.trim());
  if(typeof here==='string')text=here;
  cause=detail.cause;
 }
 text=text.replace(/\s+/g,' ').trim();
 if(/^user (rejected|denied)/i.test(text))return '';
 return text.length>160?text.slice(0,157)+'…':text;
}
const quoted=(error:unknown)=>{const said=walletSaid(error);return said?` Your wallet said: “${said}”.`:''};
export {releasesLock} from './tx-lock';
// EIP-1193 / EIP-1474 codes that mean the wallet refused the request itself, before processing it: 4100 unauthorised,
// 4200 unsupported method, -32601 method not found, -32602 invalid parameters. NOT included: 4900/4901 (disconnected)
// and -32002 (resource unavailable). A disconnect can happen after the wallet has already forwarded the transaction,
// and -32002 is not defined narrowly enough to prove that nothing was sent, so once the send method has been called
// those stay "uncertain" (fail closed) and the request stays locked until recovery finds out.
const NOT_SENT_CODES=new Set([4100,4200,-32601,-32602]);
// Errors viem raises itself before it calls the wallet's send method.
const NOT_SENT_NAMES=new Set(['ChainMismatchError','ChainNotFoundError','AccountNotFoundError','ClientChainNotConfiguredError']);
/**
 * Classifies a failed wallet request by walking the nested causes that viem and wallets attach.
 * `sendInvoked` says whether the wallet's send method was called: false means it provably was not (nothing can have
 * been sent), 'unknown' is treated like true.
 */
export function classifyWalletError(error:unknown,sendInvoked:boolean|'unknown'='unknown'):'rejected'|'not-sent'|'uncertain'{
 let notSent=false,cause:unknown=error;
 for(let i=0;i<8&&cause;i++){
  const detail=cause as {code?:unknown;name?:unknown;cause?:unknown};
  if(detail.code===4001)return 'rejected';
  if((typeof detail.code==='number'&&NOT_SENT_CODES.has(detail.code))||(typeof detail.name==='string'&&NOT_SENT_NAMES.has(detail.name)))notSent=true;
  cause=detail.cause;
 }
 return notSent||sendInvoked===false?'not-sent':'uncertain';
}
const SEND_METHODS=new Set(['eth_sendTransaction','wallet_sendTransaction']);
/**
 * Wraps the wallet so that one request can reach its send method at most once. viem retries a failed
 * eth_sendTransaction as wallet_sendTransaction for some errors; this page never lets that happen, because the first
 * attempt may have been accepted despite the error. The second attempt is refused with "method not supported", which
 * makes viem report the FIRST error, and that is what gets classified.
 */
export function singleSend(provider:Provider){
 let invoked=false,observed=false;
 const wrapped={request:async(args:{method:string;params?:unknown})=>{
  observed=true;
  if(SEND_METHODS.has(args.method)){
   if(invoked)throw Object.assign(new Error('A second send attempt for the same request was blocked.'),{code:-32004});
   invoked=true;
  }
  return provider.request(args as never);
 }} as Provider;
 /** true: send was called; false: the wallet was used but send was never called; 'unknown': the wallet was never reached through this wrapper. */
 return {provider:wrapped,sendInvoked:():boolean|'unknown'=>invoked?true:observed?false:'unknown'};
}
/**
 * Simulates, asks the wallet, then follows the transaction to its real outcome.
 * `onHash` is called with the hash the wallet returned and again with the new hash if the wallet speeds the
 * transaction up. A cancellation or an unrelated replacement is reported as such and never as success.
 */
export async function send(c:Connection,address:Address,abi:Abi,functionName:string,args:unknown[],onHash:(hash:Hex)=>void,value=0n,beforeWalletRequest:()=>unknown=()=>{}):Promise<TransactionReceipt>{
 await guard(c);
 const simulation=await client.simulateContract({account:c.address,address,abi,functionName,args,value});
 const gas=await client.estimateContractGas({account:c.address,address,abi,functionName,args,value});
 await guard(c);
 const once=singleSend(c.provider);
 const wallet=createWalletClient({account:c.address,chain,transport:custom(once.provider,{retryCount:0})});
 let hash:Hex;
 // Persist a lock BEFORE opening the wallet, including reloads while its prompt is open. If it cannot be stored, the
 // wallet is never opened.
 await beforeWalletRequest();
 try{hash=await wallet.writeContract({...simulation.request,gas:gas*2n});}
 catch(e){
  const kind=classifyWalletError(e,once.sendInvoked());
  // One message per outcome. "Rejected" also covers a wallet that closed its window after showing its own error.
  if(kind==='rejected')throw new TxError('TX_REJECTED','The request was not approved in your wallet (rejected, or the wallet window was closed), so nothing was submitted.'+quoted(e));
  if(kind==='not-sent')throw new TxError('TX_NOT_SENT','Your wallet could not take this request (it may be locked, busy with another request, or on a different network). Nothing was submitted.'+quoted(e));
  throw new TxError('TX_UNCERTAIN','Your wallet reported a problem and did not say whether this request was sent.'+quoted(e)+' Do not retry yet: this page is checking the network, and your wallet\'s activity list shows what happened.');
 }
 onHash(hash);
 let replaced:{reason:'repriced'|'cancelled'|'replaced';transaction:{hash:Hex}}|undefined;
 let receipt:TransactionReceipt;
 try{receipt=await client.waitForTransactionReceipt({hash,timeout:120000,onReplaced:r=>{replaced={reason:r.reason,transaction:{hash:r.transaction.hash}}}});}
 catch(e){throw new TxError('TX_PENDING',`Submitted, but no result yet (${(e as {shortMessage?:string}).shortMessage??(e as Error).message??'no response'}). Do not send it again; this page keeps checking.`,hash);}
 if(replaced){
  const replacement=replaced.transaction.hash;
  if(replaced.reason==='cancelled')throw new TxError('TX_CANCELLED','You cancelled this transaction in your wallet. Nothing was swapped, approved or moved.',replacement);
  if(replaced.reason!=='repriced')throw new TxError('TX_REPLACED','Your wallet replaced this transaction with a different one, so this request did not run. Review your balances before trying again.',replacement);
  hash=replacement;onHash(hash); // a speed-up: the same request under a new hash
 }else if(receipt.transactionHash&&receipt.transactionHash.toLowerCase()!==hash.toLowerCase())
  throw new TxError('TX_REPLACED','The network returned the result of a different transaction, so this request is not confirmed. Review your balances before trying again.',receipt.transactionHash);
 if(receipt.status!=='success')throw new TxError('TX_REVERTED','The transaction was included but failed on-chain. Nothing was swapped, approved or moved. Prices refresh automatically before you try again.',hash);
 return receipt;
}
// Use wall time as well as block time: the last testnet block may be stale.
export function transactionDeadline(blockTimestamp:bigint,nowMs=Date.now()){const now=BigInt(Math.floor(nowMs/1000));return (blockTimestamp>now?blockTimestamp:now)+1200n;}
export async function balance(address:Address,token?:Address){return token?client.readContract({address:token,abi:erc20,functionName:'balanceOf',args:[address]}):client.getBalance({address});}

const missing=(e:unknown)=>['TransactionNotFoundError','TransactionReceiptNotFoundError','BlockNotFoundError'].includes((e as {name?:string}).name??'');
const chainTx=(t:{hash:Hex;from:Address;to:Address|null;input:Hex;value:bigint;nonce:number;blockNumber:bigint|null}):ChainTx=>({hash:t.hash,from:t.from,to:t.to,input:t.input,value:t.value,nonce:t.nonce,blockNumber:t.blockNumber});
/** Read-only chain access for lock recovery. "Not found" becomes null; any other failure is thrown so recovery stays locked. */
export const chainReader:ChainReader={
 async head(){const b=await client.getBlock();return {number:b.number,timestamp:b.timestamp}},
 // At the head block that recovery just read, not "latest": both reads must describe the same chain state.
 nonce:(account,block)=>client.getTransactionCount({address:account,blockNumber:block}),
 async receipt(hash){try{const r=await client.getTransactionReceipt({hash});return {status:r.status,transactionHash:r.transactionHash}}catch(e){if(missing(e))return null;throw e}},
 async transaction(hash){try{return chainTx(await client.getTransaction({hash}))}catch(e){if(missing(e))return null;throw e}},
 async blockTransactions(number){return (await client.getBlock({blockNumber:number,includeTransactions:true})).transactions.map(chainTx)},
};
