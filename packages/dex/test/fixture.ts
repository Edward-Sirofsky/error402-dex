import {createPublicClient,createWalletClient,custom,parseEther,parseUnits, type Address, type Abi} from 'viem';
import {chain,erc20,routerAbi,factoryAbi} from '../src/shared.js';
import {factory,router,wrapped,localTestUSD,type Artifact} from '../src/contracts.js';
import {configureProtocolFee} from '../src/fees.js';
export async function fixture(feesEnabled=true){
 // Disposable in-process EVM (Hardhat's EDR) with chain ID 57057 and Hardhat's public test accounts; nothing touches a network.
 process.env.HARDHAT_DISABLE_TELEMETRY='true'; // no usage analytics or error reports: tests never contact any server
 const {createHardhatRuntimeEnvironment}=await import('hardhat/hre');
 const hre=await createHardhatRuntimeEnvironment({networks:{local:{type:'edr-simulated',chainId:57057,accounts:{count:3,accountsBalance:parseEther('100')},blockGasLimit:30000000,loggingEnabled:false}}});
 const connection=await hre.network.connect('local');const provider=connection.provider;
 const transport=custom(provider as never);const client=createPublicClient({chain,transport});const wallet=createWalletClient({chain,transport});
 const [owner,other,treasury]=await wallet.getAddresses();if(!owner||!other||!treasury)throw new Error('No test accounts');
 const write=async(address:Address,abi:Abi,functionName:string,args:unknown[]=[],value=0n,account=owner)=>{const gas=await client.estimateContractGas({account,address,abi,functionName,args,value});const hash=await wallet.writeContract({account,chain,address,abi,functionName,args,value,gas:gas*2n});const receipt=await client.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw new Error('Reverted '+functionName+' gas used '+receipt.gasUsed+' estimate '+gas);return receipt;};
 const deploy=async(a:Artifact,args:unknown[]=[])=>{const hash=await wallet.deployContract({account:owner,chain,abi:a.abi,bytecode:a.bytecode,args,gas:12000000n});const receipt=await client.waitForTransactionReceipt({hash});if(!receipt.contractAddress||receipt.status!=='success')throw new Error('Deploy failed');return receipt.contractAddress;};
 const wrapperArtifact=wrapped();const w=await deploy(wrapperArtifact);const f=await deploy(factory,[owner]);const r=await deploy(router,[f,w]);const token=await deploy(localTestUSD());const usd=await deploy(localTestUSD());
 if(feesEnabled)await configureProtocolFee({treasury,admin:owner,
  readRecipient:()=>client.readContract({address:f,abi:factoryAbi,functionName:'feeTo'}),
  readAdmin:()=>client.readContract({address:f,abi:factoryAbi,functionName:'feeToSetter'}),
  setRecipient:recipient=>write(f,factoryAbi,'setFeeTo',[recipient])});
 const deadline=(await client.getBlock()).timestamp+3600n;
 for(const t of [token,usd]){await write(t,erc20,'mint',[owner,parseUnits('10000',6)]);await write(t,erc20,'approve',[r,parseUnits('10000',6)]);await write(r,routerAbi,'addLiquidityETH',[t,parseUnits('1000',6),parseUnits('1000',6),parseEther('1'),owner,deadline],parseEther('1'));}
 const p=await client.readContract({address:f,abi:factoryAbi,functionName:'getPair',args:[w,token]});
 return {client,wallet,owner,other,treasury,w,f,r,token,usd,p,deadline,write,wrapperArtifact,close:()=>connection.close()};
}
