import {type Abi,type Address} from 'viem';
import {erc20,factoryAbi,pairAbi,minimumOutput} from '../../dex/src/shared';
import {liquidityAbi,removalAmounts} from './market';

/**
 * Everything the pool screen and a withdrawal depend on, read at ONE block and tagged with the pair and the account it
 * belongs to. Reads that are not pinned to one block can mix states that never existed together (for example old
 * reserves with a newer, larger LP supply after someone else added liquidity), which would understate what a position
 * is worth and weaken the withdrawal minimums computed from it.
 */
export interface PoolSnapshot {
 pair:Address;
 /** The account whose LP balance `lp` is; null when no wallet is connected (then `lp` is 0). */
 account:Address|null;
 block:bigint;
 /** Timestamp of `block`. */
 time:bigint;
 native:bigint;
 token:bigint;
 total:bigint;
 lp:bigint;
 kLast:bigint;
 /** Whether the protocol fee was switched on at `block` (it mints LP shares to the treasury on the next burn). */
 feeOn:boolean;
}
type Read=(args:{address:Address;abi:Abi;functionName:string;args?:readonly unknown[];blockNumber:bigint})=>Promise<unknown>;
export interface SnapshotReader{
 getBlockNumber(args:{cacheTime:number}):Promise<bigint>;
 getBlock(args:{blockNumber:bigint}):Promise<{timestamp:bigint}>;
 readContract:Read;
}
const ZERO='0x0000000000000000000000000000000000000000';

/** Reads one coherent snapshot: a fresh (uncached) block number first, then every value at exactly that block. */
export async function readPool(reader:SnapshotReader,where:{pair:Address;account:Address|null;wrapped:Address;factory:Address}):Promise<PoolSnapshot>{
 const block=await reader.getBlockNumber({cacheTime:0});
 const at=(address:Address,abi:Abi,functionName:string,args?:readonly unknown[])=>reader.readContract({address,abi,functionName,...(args?{args}:{}),blockNumber:block});
 const [reserves,token0,total,kLast,feeTo,lp,head]=await Promise.all([
  at(where.pair,pairAbi as Abi,'getReserves') as Promise<readonly [bigint,bigint,number]>,
  at(where.pair,pairAbi as Abi,'token0') as Promise<Address>,
  at(where.pair,liquidityAbi as Abi,'totalSupply') as Promise<bigint>,
  at(where.pair,liquidityAbi as Abi,'kLast') as Promise<bigint>,
  at(where.factory,factoryAbi as Abi,'feeTo') as Promise<Address>,
  where.account?at(where.pair,erc20 as Abi,'balanceOf',[where.account]) as Promise<bigint>:Promise.resolve(0n),
  reader.getBlock({blockNumber:block}),
 ]);
 const nativeFirst=token0.toLowerCase()===where.wrapped.toLowerCase();
 return {pair:where.pair,account:where.account,block,time:head.timestamp,native:reserves[nativeFirst?0:1],token:reserves[nativeFirst?1:0],total,lp,kLast,feeOn:feeTo.toLowerCase()!==ZERO};
}

const same=(a:Address|null|undefined,b:Address|null|undefined)=>!!a&&!!b&&a.toLowerCase()===b.toLowerCase();
/** The snapshot's position, only if it belongs to `account` and `pair`; otherwise undefined (still loading for this wallet). */
export const positionOf=(pool:PoolSnapshot|undefined,account:Address|undefined,pair:Address)=>pool&&same(pool.account,account)&&same(pool.pair,pair)?pool:undefined;

/** What withdrawing the whole position returns according to `pool`, and the minimums sent with it. */
export function withdrawal(pool:PoolSnapshot,slippageBps:number){
 const amounts=removalAmounts(pool.native,pool.token,pool.total,pool.lp,pool.kLast,pool.feeOn);
 return {native:amounts.native,token:amounts.token,minNative:minimumOutput(amounts.native,slippageBps),minToken:minimumOutput(amounts.token,slippageBps)};
}

/**
 * Checks a withdrawal at the moment of the click. `shown` is the snapshot whose amounts the user was looking at;
 * `fresh` is read again for the same account and pair. The minimums sent are the ones that were shown (never lowered
 * by a later read), and only if the fresh, coherent state still covers them; any change to the LP balance or a pool
 * move that the shown minimums no longer cover stops the withdrawal so the user can review the new figures.
 */
export function checkWithdrawal(shown:PoolSnapshot|undefined,fresh:PoolSnapshot,account:Address,slippageBps:number){
 if(!shown||!same(shown.account,account)||!same(fresh.account,account)||!same(shown.pair,fresh.pair))throw new Error('Your position is still loading for this wallet. Try again in a moment.');
 if(fresh.lp===0n)throw new Error('No liquidity position in this wallet');
 if(fresh.lp!==shown.lp)throw new Error('Your LP balance changed. Review the updated position, then remove again.');
 const reviewed=withdrawal(shown,slippageBps),now=withdrawal(fresh,slippageBps);
 if(now.native<reviewed.minNative||now.token<reviewed.minToken)throw new Error('The pool moved more than the 0.5% allowed since these amounts were shown. Review the updated amounts, then remove again.');
 return {lp:fresh.lp,minNative:reviewed.minNative,minToken:reviewed.minToken};
}

