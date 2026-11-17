// zkSYS testnet (57057) is the only network this site may act on. Uses the REAL viem wallet client against a
// simulated node (fetch is stubbed) and a simulated wallet, so viem's own chain check is exercised too.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {send,erc20,type Connection} from '../src/wallet';

const user='0x00000000000000000000000000000000000000a1',router='0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff',token='0x233440c6155e0ad350ebcf33013bc9b52ad37793';
const word=(n:number)=>n.toString(16).padStart(64,'0');
const HASH='0x'+'aa'.repeat(32);
let nodeChain='0xdee1';
function node(method:string):unknown{
 switch(method){
  case 'eth_chainId':return nodeChain;case 'eth_blockNumber':return '0x10';case 'eth_call':return '0x'+word(1);case 'eth_estimateGas':return '0x10000';
  case 'eth_gasPrice':return '0x1';case 'eth_getTransactionCount':return '0x7';
  case 'eth_getTransactionReceipt':return {transactionHash:HASH,status:'0x1',blockNumber:'0x10',blockHash:'0x'+'cc'.repeat(32),from:user,to:token,gasUsed:'0x5208',cumulativeGasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[],logsBloom:'0x'+'00'.repeat(256),transactionIndex:'0x0',type:'0x0',contractAddress:null};
  default:throw {code:-32601,message:'method '+method+' not available'};
 }
}
beforeEach(()=>{nodeChain='0xdee1';
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:{body:string})=>{const body=JSON.parse(init.body);const one=(r:{id:number;method:string})=>{try{return {jsonrpc:'2.0',id:r.id,result:node(r.method)}}catch(error){return {jsonrpc:'2.0',id:r.id,error}}};return new Response(JSON.stringify(Array.isArray(body)?body.map(one):one(body)),{status:200,headers:{'content-type':'application/json'}})}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});

/** A wallet whose network answers come from `chains` in order (the last one repeats). */
function wallet(chains:string[]){
 const calls:{method:string;params?:unknown}[]=[];let i=0;
 const request=vi.fn(async({method,params}:{method:string;params?:unknown})=>{calls.push({method,params});
  if(method==='eth_chainId')return chains[Math.min(i++,chains.length-1)];
  if(method==='eth_accounts')return [user];
  if(method==='eth_sendTransaction')return HASH;
  throw {code:-32601,message:'not available'};
 });
 return {connection:{address:user as `0x${string}`,name:'SIMULATED WALLET',provider:{request} as never} as Connection,calls};
}
const approve=(c:Connection,before=()=>{})=>send(c,token as `0x${string}`,erc20,'approve',[router,1n],()=>{},0n,before);
const sent=(calls:{method:string}[])=>calls.filter(c=>c.method==='eth_sendTransaction');

it('wallet on another network: refused before anything is simulated or sent',async()=>{
 const {connection,calls}=wallet(['0x1']);
 await expect(approve(connection)).rejects.toThrow('Switch this wallet to zkSYS Testnet (57057)');
 expect(sent(calls)).toHaveLength(0);
 expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

it('wallet switches network after the page checked: the request never reaches the wallet as a transaction',async()=>{
 // Both page checks see 57057; the wallet has moved to Ethereum (0x1) by the time the request is made.
 const {connection,calls}=wallet(['0xdee1','0xdee1','0x1']);let opened=false;
 await expect(approve(connection,()=>{opened=true})).rejects.toMatchObject({code:'TX_NOT_SENT'});
 expect(opened).toBe(true);
 expect(sent(calls)).toHaveLength(0);
});

it('the public RPC reports another network: refused before the wallet is asked',async()=>{
 nodeChain='0x1';const {connection,calls}=wallet(['0xdee1']);
 await expect(approve(connection)).rejects.toThrow('only zkSYS testnet 57057');
 expect(sent(calls)).toHaveLength(0);
});

it('the wallet network is checked again immediately before the transaction is handed to it',async()=>{
 // viem sends wallet transactions without a chainId field (the wallet signs for its active network), so the
 // protection is this last check: the call just before eth_sendTransaction is eth_chainId returning 57057.
 const {connection,calls}=wallet(['0xdee1']);
 await expect(approve(connection)).resolves.toMatchObject({status:'success'});
 const methods=calls.map(c=>c.method),at=methods.indexOf('eth_sendTransaction');
 expect(sent(calls)).toHaveLength(1);
 expect(methods.slice(0,at).filter(m=>m==='eth_chainId').length).toBe(3); // two page checks + viem's own
 expect(methods[at-1]).toBe('eth_chainId');
});
