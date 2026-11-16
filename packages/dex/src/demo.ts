import {parseEther,formatUnits} from 'viem';
import {fixture} from '../test/fixture.js';
import {routerAbi,erc20,minimumOutput} from './shared.js';
const x=await fixture();
try{const input=parseEther('.01');const amounts=await x.client.readContract({address:x.r,abi:routerAbi,functionName:'getAmountsOut',args:[input,[x.w,x.token]]});const before=await x.client.readContract({address:x.token,abi:erc20,functionName:'balanceOf',args:[x.other]});const receipt=await x.write(x.r,routerAbi,'swapExactETHForTokens',[minimumOutput(amounts[1]!,50),[x.w,x.token],x.other,x.deadline],input);const after=await x.client.readContract({address:x.token,abi:erc20,functionName:'balanceOf',args:[x.other]});if(after<=before)throw new Error('No output');console.log(JSON.stringify({environment:'DISPOSABLE LOCAL EVM — synthetic tokens, no wallet keys',input:'0.01 native test SYS',output:formatUnits(after-before,6),transaction:receipt.transactionHash,result:'confirmed'},null,2));}finally{await x.close()}
