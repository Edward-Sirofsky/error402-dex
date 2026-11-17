// "TransferHelper: TRANSFER_FROM_FAILED" when adding liquidity (reported on beta-0.3.0): the deposit asked the router
// for more of the token than the wallet held. The page now checks both balances first and says what the wallet covers.
// The same check against the real Uniswap V2 router: packages/dex/test/deposit-router.test.ts.
import {describe,expect,it} from 'vitest';
import {parseEther} from 'viem';
import {checkDeposit,depositNeeds} from '../src/deposit';

// The live TSYS / ZKSYS pool and the wallet balances at the time of the report.
const pool={native:parseEther('0.01007743'),token:parseEther('0.99241123')};
const wallet={native:parseEther('0.96564472'),token:parseEther('2.00758877')};

describe('deposits are checked against the wallet before anything is approved or simulated',()=>{
 it('the reported case: 0.1 TSYS needs about 9.85 ZKSYS, the wallet has 2.01 — refused with the amount it can cover',()=>{
  expect(()=>checkDeposit(pool,parseEther('0.1'),parseEther('9.84787'),wallet,18,'ZKSYS')).toThrow(/needs 9\.8\d* ZKSYS, but your wallet has 2\.00759 ZKSYS\. At the pool's current ratio you can deposit up to about 0\.0202\d* TSYS/);
 });
 it('a deposit the wallet covers passes, and the amounts are what the router will take',()=>{
  const need=checkDeposit(pool,parseEther('0.02'),parseEther('1.97'),wallet,18,'ZKSYS');
  expect(need.native).toBe(parseEther('0.02'));expect(need.token).toBe(parseEther('0.02')*pool.token/pool.native);
 });
 it('extra token typed above the ratio is not needed (the router takes only the matching amount)',()=>{
  expect(depositNeeds(pool,parseEther('0.01'),parseEther('5'))).toEqual({native:parseEther('0.01'),token:parseEther('0.01')*pool.token/pool.native});
  expect(()=>checkDeposit(pool,parseEther('0.01'),parseEther('5'),wallet,18,'ZKSYS')).not.toThrow();
 });
 it('not enough TSYS (the deposit plus gas) is refused too',()=>{
  expect(()=>checkDeposit(pool,parseEther('0.96564472'),parseEther('96'),{native:wallet.native,token:parseEther('100')},18,'ZKSYS')).toThrow(/plus network gas/);
 });
 it('a wallet without the token is told to get some first',()=>{
  expect(()=>checkDeposit(pool,parseEther('0.001'),parseEther('0.1'),{native:wallet.native,token:0n},18,'ZKSYS')).toThrow(/Get some ZKSYS first/);
 });
});

