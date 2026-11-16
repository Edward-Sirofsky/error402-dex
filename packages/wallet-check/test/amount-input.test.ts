// Remediation of audit finding F-7: decimal comma and leading-decimal input, with one parser for every field.
import {describe,it,expect} from 'vitest';
import {amount,normalizeAmount} from '../src/wallet';
import {approvalAmount} from '../src/quote-flow';

describe('amount input formats',()=>{
 it('accepts a leading decimal point and a decimal comma, exactly',()=>{expect(amount('.5',18)).toBe(5n*10n**17n);expect(amount('0,5',18)).toBe(5n*10n**17n);expect(amount(',5',6)).toBe(500000n);expect(amount('0.5',18)).toBe(amount('0,5',18));expect(amount('12,25',6)).toBe(12250000n);expect(amount('0,000001',6)).toBe(1n)});
 it('trims surrounding spaces from pasted values',()=>{expect(amount(' 1.5 ',6)).toBe(1500000n);expect(amount('\t0,5\n',6)).toBe(500000n)});
 it('keeps full precision with no floating-point rounding',()=>{expect(amount('0.123456789012345678',18)).toBe(123456789012345678n);expect(amount('123456789012345678901234567890.000000000000000001',18)).toBe(123456789012345678901234567890000000000000000001n);expect(amount('0,1',18)+amount('0,2',18)).toBe(amount('0.3',18))});
 it('rejects ambiguous thousands-style commas instead of guessing',()=>{for(const text of ['1,000','12,345','999,999'])expect(()=>amount(text,18),text).toThrow(/could mean/);expect(amount('0,500',18)).toBe(5n*10n**17n);expect(amount('1234,567',18)).toBe(1234567n*10n**15n);expect(amount('1.000',18)).toBe(10n**18n)});
 it('rejects malformed, negative and unsupported notation',()=>{for(const text of ['','  ','.',',','1.','1,','1.2.3','1,2,3','1,000.5','1.000,5','1 000','1_000','-1','+1','−1','1e3','1E-3','0x10','١٢','½','abc','1.5 TSYS','NaN','Infinity'])expect(()=>amount(text,18),JSON.stringify(text)).toThrow()});
 it('rejects excess precision and zero',()=>{expect(()=>amount('0,0000001',6)).toThrow(/decimal places/);expect(()=>amount('.0000000000000000001',18)).toThrow(/decimal places/);for(const text of ['0','0.0','0,00','.0'])expect(()=>amount(text,18),text).toThrow(/greater than zero/)});
 it('normalises to digits only',()=>{expect(normalizeAmount('.5')).toEqual({whole:'0',fraction:'5'});expect(normalizeAmount('7')).toEqual({whole:'7',fraction:''});expect(normalizeAmount('7,25')).toEqual({whole:'7',fraction:'25'})});
});
describe('custom approval limits use the same parser as swap and liquidity amounts',()=>{
 it('accepts a comma and a leading decimal',()=>{expect(approvalAmount('custom',1n,'2,5',6)).toBe(2500000n);expect(approvalAmount('custom',1n,'.75',6)).toBe(750000n)});
 it('rejects the same malformed input',()=>{expect(()=>approvalAmount('custom',1n,'1,000',6)).toThrow(/could mean/);expect(()=>approvalAmount('custom',1n,'-1',6)).toThrow();expect(()=>approvalAmount('custom',1n,'1e3',6)).toThrow();expect(()=>approvalAmount('custom',2000000n,'1,5',6)).toThrow(/cover/)});
});
