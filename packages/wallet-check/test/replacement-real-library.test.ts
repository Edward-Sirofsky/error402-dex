// Uses the REAL viem receipt waiter against a SIMULATED node (fetch is stubbed), so the library's actual
// replacement detection is exercised end to end. The wallet is still a mock: a real MetaMask Cancel / Speed up
// remains a manual test with a real wallet.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const write=vi.hoisted(()=>vi.fn());
vi.mock('viem',async importOriginal=>({...await importOriginal<typeof import('viem')>(),createWalletClient:()=>({writeContract:write})}));
import {send,erc20,routerAbi,type Connection} from '../src/wallet';

const user='0x00000000000000000000000000000000000000a1',router='0x41c6eb669e90c8233a574c23c5bfcb72d8c5acff',token='0x233440c6155e0ad350ebcf33013bc9b52ad37793';
const submitted=('0x'+'aa'.repeat(32)) as `0x${string}`,second=('0x'+'bb'.repeat(32)) as `0x${string}`,blockHash='0x'+'cc'.repeat(32);
const original={hash:submitted,from:user,to:token,nonce:'0x7',value:'0x0',input:'0x095ea7b3',gas:'0x10000',gasPrice:'0x1',blockNumber:null,blockHash:null,transactionIndex:null,type:'0x0',chainId:'0xdee1',v:'0x1b',r:'0x1',s:'0x1'};
const mined=(over:object)=>({...original,hash:second,blockNumber:'0x10',blockHash,transactionIndex:'0x0',...over});
const receipt=(status:string)=>({transactionHash:second,status,blockNumber:'0x10',blockHash,from:user,to:user,gasUsed:'0x5208',cumulativeGasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[],logsBloom:'0x'+'00'.repeat(256),transactionIndex:'0x0',type:'0x0',contractAddress:null});
const word=(n:number)=>n.toString(16).padStart(64,'0');
const TRUE='0x'+word(1),AMOUNTS='0x'+word(32)+word(2)+word(1)+word(2); // bool true; uint256[] [1,2]
let inBlock:object,status='0x1',callResult=TRUE;
function node(method:string,params:unknown[]):unknown{
 switch(method){
  case 'eth_chainId':return '0xdee1';case 'eth_blockNumber':return '0x10';case 'eth_call':return callResult;case 'eth_estimateGas':return '0x10000';
  case 'eth_gasPrice':return '0x1';case 'eth_getTransactionCount':return '0x7';
  case 'eth_getTransactionByHash':return params[0]===submitted?original:inBlock;
  case 'eth_getTransactionReceipt':return params[0]===second?receipt(status):null; // the submitted hash itself is never mined
  case 'eth_getBlockByNumber':return {number:'0x10',hash:blockHash,parentHash:'0x'+'dd'.repeat(32),timestamp:'0x6af00000',gasLimit:'0x1c9c380',gasUsed:'0x5208',miner:user,nonce:'0x0000000000000000',difficulty:'0x0',totalDifficulty:'0x0',size:'0x100',extraData:'0x',logsBloom:'0x'+'00'.repeat(256),transactions:[inBlock],uncles:[]};
  default:throw {code:-32601,message:'method '+method+' not available'};
 }
}
beforeEach(()=>{status='0x1';callResult=TRUE;write.mockReset();write.mockResolvedValue(submitted);
 vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:{body:string})=>{const body=JSON.parse(init.body);const one=(r:{id:number;method:string;params:unknown[]})=>{try{return {jsonrpc:'2.0',id:r.id,result:node(r.method,r.params??[])}}catch(error){return {jsonrpc:'2.0',id:r.id,error}}};return new Response(JSON.stringify(Array.isArray(body)?body.map(one):one(body)),{status:200,headers:{'content-type':'application/json'}})}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
const connection=():Connection=>({address:user as `0x${string}`,name:'SIMULATED WALLET',provider:{request:vi.fn(async({method}:{method:string})=>method==='eth_chainId'?'0xdee1':[user]) as never}});
const approve=(journal:(h:`0x${string}`)=>void)=>send(connection(),token as `0x${string}`,erc20,'approve',[router,1n],journal);

it('wallet Cancel (0-value self-transfer with the same nonce): reported as cancelled, never as confirmed',async()=>{
 inBlock=mined({to:user,input:'0x'});const journal:string[]=[];
 await expect(approve(h=>journal.push(h))).rejects.toMatchObject({code:'TX_CANCELLED',hash:second});
 expect(journal).toEqual([submitted]);
});
it('wallet Speed up (same request, same nonce, new hash): followed to success under the new hash',async()=>{
 inBlock=mined({gasPrice:'0x2'});const journal:string[]=[];
 const result=await approve(h=>journal.push(h));
 expect(result.status).toBe('success');expect(result.transactionHash).toBe(second);expect(journal).toEqual([submitted,second]);
});
it('wallet Speed up that fails on-chain: reported as failed',async()=>{inBlock=mined({gasPrice:'0x2'});status='0x0';await expect(approve(()=>{})).rejects.toMatchObject({code:'TX_REVERTED',hash:second})});
it('a different transaction in the same nonce slot: reported as replaced',async()=>{inBlock=mined({to:router,input:'0xdeadbeef'});await expect(approve(()=>{})).rejects.toMatchObject({code:'TX_REPLACED',hash:second})});
it('a cancelled swap is handled the same way as a cancelled approval',async()=>{
 inBlock=mined({to:user,input:'0x'});callResult=AMOUNTS;
 await expect(send(connection(),router as `0x${string}`,routerAbi,'swapExactETHForTokens',[1n,[token,router],user,9999999999n],()=>{},1n)).rejects.toMatchObject({code:'TX_CANCELLED'});
});
