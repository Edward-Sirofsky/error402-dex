import {type Address, type Hex} from 'viem';

/**
 * Persisted record of one wallet request, written BEFORE the wallet is asked to sign.
 * It replaces the old bare "unknown"/hash string so that an interrupted request can be recovered
 * without guessing: recovery either finds the exact transaction, proves that it can no longer run,
 * or keeps the lock. It never resubmits anything.
 */
export type TxKind = 'approve' | 'swap' | 'addLiquidity' | 'removeLiquidity' | 'legacy';
export interface PendingRecord {
  v: 2;
  id: string;
  kind: TxKind;
  /** Plain-language description shown to the user, e.g. "Swap 0.0001 TSYS for ZKSYS". */
  label: string;
  /** null only for records migrated from the old format, where the account was not stored. */
  account: Address | null;
  chainId: 57057;
  to: Address | null;
  /** Calldata of the request as built by this page (the wallet may edit an approval amount). */
  data: Hex | null;
  value: string;
  /** Router deadline in unix seconds. After it, the transaction can only revert. null = no deadline (approvals). */
  deadline: number | null;
  /** The account's mined-transaction count when the request was made: the transaction's nonce is >= this. */
  nonce: number | null;
  /** Block number when the request was made: the transaction cannot be in an earlier block. */
  block: string | null;
  createdAt: number;
  phase: 'awaiting-wallet' | 'submitted';
  hash?: Hex;
  /** Nonce actually used, once the transaction has been seen. */
  txNonce?: number;
  /** Set when a speed-up replaced the original hash with an identical request. */
  repricedFrom?: Hex;
  /** The wallet failed without saying whether it sent anything. */
  uncertain?: boolean;
  /** Last block already searched for this request, so repeated checks stay cheap. */
  scannedTo?: string;
}
export interface ChainTx { hash: Hex; from: Address; to: Address | null; input: Hex; value: bigint; nonce: number; blockNumber: bigint | null }
/** Read-only chain access needed for recovery. Injected so the logic can be tested without a network. */
export interface ChainReader {
  head(): Promise<{number: bigint; timestamp: bigint}>;
  /** The account's mined-transaction count as of block `block` (not "latest"). */
  nonce(account: Address, block: bigint): Promise<number>;
  receipt(hash: Hex): Promise<{status: 'success' | 'reverted'; transactionHash: Hex} | null>;
  transaction(hash: Hex): Promise<ChainTx | null>;
  blockTransactions(number: bigint): Promise<ChainTx[]>;
}
export type Resolution =
  | {state: 'confirmed' | 'reverted'; hash: Hex; repriced: boolean}
  | {state: 'cancelled' | 'replaced'; hash: Hex}
  | {state: 'expired'}
  | {state: 'submitted'; hash: Hex; seen: boolean; dismissible: boolean}
  | {state: 'awaiting'; until: number | null; dismissible: boolean};
export const isFinal = (r: Resolution) => r.state !== 'submitted' && r.state !== 'awaiting';

export const LOCK_KEY = 'error402-testnet-pending-v2';
export const LEGACY_LOCK_KEY = 'error402-testnet-pending-v1';
/**
 * An approval (or a request of unknown kind from the previous version) that is visibly pending stays locked for this
 * long, then the user may stop tracking it. Stopping tracking is NOT a cancellation: the page says so, and says that
 * the transaction may still be mined. This uses the local clock only to decide when to OFFER that choice; it is
 * never used to claim that anything has expired or did not execute.
 */
export const APPROVAL_DISMISS_AFTER_MS = 600000;
/** Requests whose router call carries a deadline. Only these can ever be declared "expired", and only by chain time. */
const DEADLINE_KINDS: TxKind[] = ['swap', 'addLiquidity', 'removeLiquidity'];
/** The router deadline of a request, or null if it has none (approvals) or its kind is unknown (legacy / corrupt). */
export const routerDeadline = (r: PendingRecord) => DEADLINE_KINDS.includes(r.kind) && r.deadline !== null ? r.deadline : null;
/** Upper bound on blocks read by one recovery check; the search continues from `scannedTo` on the next check. */
export const SCAN_BLOCKS_PER_CHECK = 200;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const isAddress = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const kinds: TxKind[] = ['approve', 'swap', 'addLiquidity', 'removeLiquidity', 'legacy'];

function valid(r: unknown): r is PendingRecord {
  const x = r as PendingRecord;
  return !!x && x.v === 2 && typeof x.id === 'string' && kinds.includes(x.kind) && typeof x.label === 'string' && x.label.length <= 200
    && (x.account === null || isAddress(x.account)) && x.chainId === 57057 && (x.to === null || isAddress(x.to)) && (x.data === null || isHex(x.data))
    && typeof x.value === 'string' && /^\d+$/.test(x.value) && (x.deadline === null || isCount(x.deadline)) && (x.nonce === null || isCount(x.nonce))
    && (x.block === null || (typeof x.block === 'string' && /^\d+$/.test(x.block))) && isCount(x.createdAt) && (x.phase === 'awaiting-wallet' || x.phase === 'submitted')
    && (x.hash === undefined || isHash(x.hash)) && (x.phase !== 'submitted' || isHash(x.hash)) && (x.txNonce === undefined || isCount(x.txNonce))
    && (x.repricedFrom === undefined || isHash(x.repricedFrom)) && (x.uncertain === undefined || typeof x.uncertain === 'boolean')
    && (x.scannedTo === undefined || (typeof x.scannedTo === 'string' && /^\d+$/.test(x.scannedTo)));
}
/**
 * A lock whose details are unknown (left by the previous version, or unreadable data). Its kind is unknown — the old
 * version also stored approvals this way, and approvals have no deadline — so it is given NO deadline and can never be
 * declared expired. It is settled by its receipt (if it has a hash); otherwise the user may stop tracking it, which the
 * page describes as abandoning local tracking, not as proof that nothing happened.
 */
export function legacyRecord(now: number, hash?: Hex): PendingRecord {
  return {v: 2, id: 'legacy-' + now, kind: 'legacy', label: 'An earlier request from this browser', account: null, chainId: 57057, to: null, data: null, value: '0',
    deadline: null, nonce: null, block: null, createdAt: now, phase: hash ? 'submitted' : 'awaiting-wallet', ...(hash ? {hash} : {uncertain: true})};
}
/**
 * Reads every stored lock. Unreadable or malformed data is NOT treated as "no lock": it becomes a time-limited
 * legacy lock, so corruption can never silently unlock a request that might still be open in the wallet.
 * Throws only if the browser refuses storage access altogether.
 */
export function readLocks(storage: Store, now = Date.now()): PendingRecord[] {
  const records: PendingRecord[] = [];
  let rewrite = false;
  const raw = storage.getItem(LOCK_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > 20 || !parsed.every(valid)) throw new Error('invalid');
      records.push(...parsed);
    } catch { records.push(legacyRecord(now)); rewrite = true; }
  }
  const old = storage.getItem(LEGACY_LOCK_KEY);
  if (old !== null) { records.push(legacyRecord(now, isHash(old) ? old : undefined)); rewrite = true; }
  if (rewrite) { writeLocks(storage, records); storage.removeItem(LEGACY_LOCK_KEY); }
  return records;
}
export function writeLocks(storage: Store, records: PendingRecord[]) {
  if (records.length) storage.setItem(LOCK_KEY, JSON.stringify(records)); else storage.removeItem(LOCK_KEY);
}
const sameAccount = (a: Address | null, b: Address | null) => a === null || b === null || a.toLowerCase() === b.toLowerCase();
/** The lock that blocks `account`. Records without an account (legacy) block every account. */
export const lockFor = (records: PendingRecord[], account: Address | null) => records.find(r => sameAccount(r.account, account));
export function saveLock(storage: Store, record: PendingRecord) { writeLocks(storage, [...readLocks(storage).filter(r => r.id !== record.id), record]); }
export function clearLock(storage: Store, id: string) { writeLocks(storage, readLocks(storage).filter(r => r.id !== id)); }
/**
 * Compare-and-swap for results that arrive late (a recovery check that started before the record changed).
 * Replaces the stored record with `next` (or removes it when `next` is null) ONLY if the stored copy is still exactly
 * `expected`. Returns false and changes nothing if the record was dismissed, settled by another tab, or updated in the
 * meantime (for example by a hash the wallet reported late), so a stale result can never resurrect or overwrite it.
 */
export function replaceLock(storage: Store, expected: PendingRecord, next: PendingRecord | null): boolean {
  const records = readLocks(storage), index = records.findIndex(r => r.id === expected.id);
  if (index < 0 || JSON.stringify(records[index]) !== JSON.stringify(expected)) return false;
  writeLocks(storage, next ? records.map((r, i) => i === index ? next : r) : records.filter((_, i) => i !== index));
  return true;
}
export function newRecord(input: {kind: Exclude<TxKind, 'legacy'>; label: string; account: Address; to: Address; data: Hex; value: bigint; deadline: bigint | null; nonce: number; block: bigint; now?: number}): PendingRecord {
  const now = input.now ?? Date.now();
  return {v: 2, id: `${now}-${Math.random().toString(36).slice(2, 10)}`, kind: input.kind, label: input.label, account: input.account, chainId: 57057, to: input.to, data: input.data,
    value: input.value.toString(), deadline: input.deadline === null ? null : Number(input.deadline), nonce: input.nonce, block: input.block.toString(), createdAt: now, phase: 'awaiting-wallet'};
}

const APPROVE_PREFIX_CHARS = 2 + 8 + 64; // 0x + selector + spender; the amount may be edited inside the wallet
/** True only if `tx` is this request: same sender, same contract, same value and same calldata. */
export function sameRequest(tx: ChainTx, record: PendingRecord): boolean {
  if (!record.account || !record.to || !record.data || !tx.to) return false;
  if (tx.from.toLowerCase() !== record.account.toLowerCase() || tx.to.toLowerCase() !== record.to.toLowerCase() || tx.value !== BigInt(record.value)) return false;
  const sent = tx.input.toLowerCase(), asked = record.data.toLowerCase();
  return record.kind === 'approve' ? sent.length === asked.length && sent.slice(0, APPROVE_PREFIX_CHARS) === asked.slice(0, APPROVE_PREFIX_CHARS) : sent === asked;
}
/**
 * `sameRequest`, restricted to transactions that could have been sent for THIS request: nonce at or after the
 * account's count captured when the request was made. An identical earlier approval (approval matching ignores the
 * amount) mined in the captured block is therefore never mistaken for the current one.
 */
export const laterSameRequest = (tx: ChainTx, record: PendingRecord) => record.nonce !== null && tx.nonce >= record.nonce && sameRequest(tx, record);
const isCancellation = (tx: ChainTx) => !!tx.to && tx.to.toLowerCase() === tx.from.toLowerCase() && tx.value === 0n && (tx.input === '0x' || tx.input.length <= 2);

interface ScanResult { found?: ChainTx; scannedTo?: string; caughtUp: boolean }
async function scan(record: PendingRecord, reader: ChainReader, head: bigint, match: (tx: ChainTx) => boolean): Promise<ScanResult> {
  if (record.block === null || !record.account) return {scannedTo: record.scannedTo, caughtUp: true}; // nothing to search with
  const account = record.account.toLowerCase();
  let from = BigInt(record.block);
  if (record.scannedTo !== undefined && BigInt(record.scannedTo) + 1n > from) from = BigInt(record.scannedTo) + 1n;
  const to = from + BigInt(SCAN_BLOCKS_PER_CHECK) - 1n < head ? from + BigInt(SCAN_BLOCKS_PER_CHECK) - 1n : head;
  for (let number = from; number <= to; number++) {
    const found = (await reader.blockTransactions(number)).find(tx => tx.from.toLowerCase() === account && match(tx));
    if (found) return {found, scannedTo: record.scannedTo, caughtUp: true};
  }
  return {scannedTo: to >= from ? to.toString() : record.scannedTo, caughtUp: to >= head};
}

/**
 * Works out what happened to an interrupted request, using read-only chain data.
 *
 * Rules (none of them trusts an unrelated transaction):
 *  - a receipt for the stored hash is the outcome;
 *  - if the transaction's nonce was used by something else, that transaction is found and compared:
 *    identical request = speed-up (follow it), 0-value self-transfer = cancelled, anything else = replaced;
 *  - with no hash, only a transaction from the same account with the same contract, value and calldata, and a nonce
 *    at or after the one captured for the request, is adopted;
 *  - "expired" is declared only for a request with a router deadline, only when the latest block's timestamp (the
 *    value the router checks) is past that deadline, and only once the block search has caught up with that block.
 *    Block timestamps never go backwards, so any later inclusion can only revert. The local clock is never used: a
 *    clock jump, a lagging RPC node or a stalled chain therefore keeps the lock rather than releasing it;
 *  - otherwise the lock stays. Approvals and legacy records have no deadline and never expire; the user may stop
 *    tracking them (see `dismissible`), which is described as abandoning tracking, not as proof of anything.
 * `nowMs` is used only to decide when to offer that choice.
 */
export async function recover(input: PendingRecord, reader: ChainReader, nowMs = Date.now()): Promise<{record: PendingRecord; resolution: Resolution}> {
  let record = {...input};
  const head = await reader.head();
  // The count is read AT the head block, so both facts describe the same chain state even behind a load balancer
  // whose nodes lag each other; a node that does not have that block fails the read and the lock is kept.
  const latest = record.account ? await reader.nonce(record.account, head.number) : null;
  const deadline = routerDeadline(record);
  const pastDeadline = () => deadline !== null && Number(head.timestamp) > deadline;
  const trackable = record.kind === 'approve' || record.kind === 'legacy';
  const outcome = (status: 'success' | 'reverted', hash: Hex): Resolution => ({state: status === 'success' ? 'confirmed' : 'reverted', hash, repriced: !!record.repricedFrom});
  for (let pass = 0; pass < 2; pass++) {
    // "Expired" is only declared once the block search has caught up with the chain, so a mined speed-up is never missed.
    let caughtUp = true;
    if (record.hash) {
      const hash = record.hash;
      const receipt = await reader.receipt(hash);
      if (receipt) return {record, resolution: outcome(receipt.status, hash)};
      const tx = await reader.transaction(hash);
      if (tx) {
        record = {...record, txNonce: tx.nonce, account: record.account ?? tx.from};
        if (tx.blockNumber !== null) return {record, resolution: {state: 'submitted', hash, seen: true, dismissible: false}}; // mined; receipt not indexed yet
      }
      const waiting: Resolution = {state: 'submitted', hash, seen: !!tx, dismissible: trackable && (!tx || nowMs - record.createdAt > APPROVAL_DISMISS_AFTER_MS)};
      const slot = record.txNonce;
      // Known nonce: look for whatever used it (exact equality). Unknown nonce (the node never showed the transaction):
      // look for the same request, but never one older than the nonce captured when the request was made.
      const match = latest === null ? null
        : slot !== undefined ? (latest > slot ? (candidate: ChainTx) => candidate.nonce === slot : null)
        : record.nonce !== null && latest > record.nonce ? (candidate: ChainTx) => laterSameRequest(candidate, record) : null;
      if (match) {
        const result = await scan(record, reader, head.number, match);
        record = {...record, scannedTo: result.scannedTo};
        caughtUp = result.caughtUp;
        const found = result.found;
        if (found && found.hash.toLowerCase() !== hash.toLowerCase()) {
          const replacement = await reader.receipt(found.hash);
          if (!replacement) return {record, resolution: {state: 'submitted', hash, seen: true, dismissible: false}};
          if (sameRequest(found, record)) {
            record = {...record, hash: found.hash, txNonce: found.nonce, repricedFrom: record.repricedFrom ?? hash};
            return {record, resolution: outcome(replacement.status, found.hash)};
          }
          return {record, resolution: {state: isCancellation(found) ? 'cancelled' : 'replaced', hash: found.hash}};
        }
        if (found) return {record, resolution: {state: 'submitted', hash, seen: true, dismissible: false}};
      }
      if (caughtUp && pastDeadline()) return {record, resolution: {state: 'expired'}};
      return {record, resolution: waiting};
    }
    if (record.account && record.data && record.nonce !== null && latest !== null && latest > record.nonce) {
      const result = await scan(record, reader, head.number, candidate => laterSameRequest(candidate, record));
      if (result.found) { record = {...record, phase: 'submitted', hash: result.found.hash, txNonce: result.found.nonce, scannedTo: undefined}; continue; }
      record = {...record, scannedTo: result.scannedTo};
      caughtUp = result.caughtUp;
    }
    if (caughtUp && pastDeadline()) return {record, resolution: {state: 'expired'}};
    return {record, resolution: {state: 'awaiting', until: deadline, dismissible: trackable}};
  }
  return {record, resolution: {state: 'submitted', hash: record.hash!, seen: true, dismissible: false}};
}

/** Outcomes after which nothing from the request can still execute, so its lock may be released. */
export const releasesLock = (code: unknown) => ['TX_REJECTED', 'TX_NOT_SENT', 'TX_REVERTED', 'TX_CANCELLED', 'TX_REPLACED'].includes(code as string);
const stageOfCode: Record<string, Stage> = {TX_REJECTED: 'rejected', TX_NOT_SENT: 'not-sent', TX_REVERTED: 'reverted', TX_CANCELLED: 'cancelled', TX_REPLACED: 'replaced', TX_UNCERTAIN: 'uncertain', TX_PENDING: 'submitted'};
export interface SubmitInput {
  storage: Store;
  kind: Exclude<TxKind, 'legacy'>;
  label: string;
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  deadline: bigint | null;
  /** Reads the account's mined-transaction count and the current block; called before anything is stored. */
  position: () => Promise<{nonce: number; block: bigint}>;
  /** Performs the wallet request. Must call `beforeWallet` immediately before opening the wallet and `onHash` for every hash. */
  send: (onHash: (hash: Hex) => void, beforeWallet: () => void) => Promise<unknown>;
  /** Told about every change so the page can show it. */
  notify?: (stage: Stage, record: PendingRecord | undefined, hash?: Hex) => void;
  /**
   * A hash reported AFTER this call has already returned (for example the user chose "Stop waiting" and the wallet
   * sent the request later). The request is tracked again — re-stored as submitted even if it had been dismissed —
   * so it is followed by recovery and cannot be sent twice. `notify` is not called for it: the page may be showing
   * another action by then.
   */
  late?: (record: PendingRecord, hash: Hex) => void;
  /**
   * Cross-tab mutual exclusion for the whole request (see `webLocks`). Without it, two tabs that click within the
   * same instant could both pass the storage re-check; with it, the second is refused at once.
   */
  mutex?: Mutex;
}
/** Runs `run` while holding the exclusive lock `name`, or throws TX_LOCKED at once if another tab holds it. */
export type Mutex = (name: string, run: () => Promise<void>) => Promise<void>;
const lockedError = () => Object.assign(new Error('An earlier request is still open. See Transaction status below.'), {code: 'TX_LOCKED'});
type LockManagerLike = {request: (name: string, options: {ifAvailable: boolean}, callback: (lock: unknown) => Promise<void>) => Promise<void>};
/**
 * An atomic cross-tab lock from the browser's Web Locks API (shared by every tab of this site; released by the
 * browser if a tab crashes or closes). `ifAvailable` means a second request never waits behind an open wallet
 * prompt: it is refused immediately. Returns undefined where the API is missing; the storage re-check still applies.
 */
export function webLocks(locks: LockManagerLike | null | undefined =(globalThis as {navigator?: {locks?: LockManagerLike}}).navigator?.locks): Mutex | undefined {
  if (!locks || typeof locks.request !== 'function') return undefined;
  return (name, run) => locks.request(name, {ifAvailable: true}, async lock => { if (!lock) throw lockedError(); await run(); });
}
/** One Web Lock per account, matching one stored record per account. */
export const walletLockName = (account: Address) => `error402-wallet-request:${account.toLowerCase()}`;
/**
 * Runs one wallet request under a persisted lock.
 *  - Refuses to start if this account already has an open request (including one opened in another tab).
 *  - Stores the record before the wallet opens; if it cannot be stored, the wallet is never opened.
 *  - Removes the record only when the outcome is certain. Uncertain and still-pending requests stay locked
 *    for `recover`. Nothing is retried or resubmitted here.
 * Rethrows whatever `send` threw so the caller can show the message.
 */
export async function submitWithLock(input: SubmitInput): Promise<void> {
  // Held from before the storage check until the request settles (or the user stops waiting), so a second tab
  // cannot slip between another tab's check and its stored record.
  if (input.mutex) return input.mutex(walletLockName(input.account), () => submitUnderLock(input));
  return submitUnderLock(input);
}
async function submitUnderLock(input: SubmitInput): Promise<void> {
  const {storage, account, notify} = input;
  if (lockFor(readLocks(storage), account)) throw lockedError();
  const {nonce, block} = await input.position();
  let record: PendingRecord | undefined;
  /** Set once this call has returned or thrown; anything the wallet reports afterwards is a late callback. */
  let settled = false;
  const persist = (next: PendingRecord) => { record = next; saveLock(storage, next); };
  const release = () => { if (record) { try { clearLock(storage, record.id); } catch { /* storage vanished: nothing more can be done */ } } };
  try {
    await input.send(hash => {
      if (record) {
        const speedUp = record.hash && record.hash.toLowerCase() !== hash.toLowerCase();
        try { persist({...record, phase: 'submitted', hash, uncertain: undefined, scannedTo: undefined, ...(speedUp ? {repricedFrom: record.repricedFrom ?? record.hash} : {})}); } catch { /* the transaction is already sent; keep going */ }
      }
      if (settled) { if (record) input.late?.(record, hash); return; }
      notify?.('submitted', record, hash);
    }, () => {
      // The caller already gave up on this request (e.g. "Stop waiting"): never open the wallet after that.
      if (settled) throw Object.assign(new Error('This request was abandoned before the wallet opened.'), {code: 'TX_NOT_SENT'});
      // Re-check at the last moment: another tab may have opened a request while this one was simulating.
      if (lockFor(readLocks(storage), account)) throw lockedError();
      persist(newRecord({kind: input.kind, label: input.label, account, to: input.to, data: input.data, value: input.value, deadline: input.deadline, nonce, block}));
      notify?.('awaiting-wallet', record);
    });
  } catch (e) {
    settled = true;
    const error = e as {code?: string; hash?: Hex};
    if (releasesLock(error.code)) release();
    else if (error.code === 'TX_UNCERTAIN' && record) { try { persist({...record, uncertain: true}); } catch { /* keep the stored record as it is */ } }
    if (error.code && stageOfCode[error.code]) notify?.(stageOfCode[error.code], releasesLock(error.code) ? undefined : record, error.hash);
    throw e;
  }
  settled = true;
  release();
  notify?.('confirmed', undefined, record?.hash);
}

const clock = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 16) + ' UTC';
/** Short heading for the transaction-status panel. */
export const stageLabels = {
  idle: '', 'awaiting-wallet': 'Waiting for your wallet', submitted: 'Submitted — waiting for the network', confirmed: 'Confirmed', reverted: 'Failed on-chain',
  rejected: 'Rejected in wallet', 'not-sent': 'Not sent', cancelled: 'Cancelled in wallet', replaced: 'Replaced in wallet', uncertain: 'Outcome not yet known', expired: 'Expired — not executed',
} as const;
export type Stage = keyof typeof stageLabels;
const autoUnlock = (deadline: number) => ` It unlocks automatically once the network has produced a block after ${clock(deadline)} (its time limit) without it going through. If the network is not producing blocks, it stays locked until it does.`;
/** What stopping tracking means, said wherever it is offered. It never claims that anything was cancelled or did not run. */
function trackingNote(record: PendingRecord, pending: boolean): string {
  if (record.kind === 'legacy') return ' This page cannot tell what this earlier request was or whether it went through. Check your wallet\'s activity list first. You can then stop tracking it below: that does not cancel anything, and if it is still open or pending it may still go through.';
  return pending
    ? ' It is still pending on the network. You can stop tracking it below, but that does not cancel it: it may still be mined and set the spending limit it shows. Cancel it in your wallet if you do not want it.'
    : ' An approval only sets a spending limit and moves no funds, so you can stop tracking it below once you have rejected or closed it. That does not cancel it: if you confirm it in your wallet later, it will still set the limit shown there.';
}
/** Plain-language explanation of a lock and of what the user can do about it. */
export function explain(record: PendingRecord, resolution?: Resolution): {stage: Stage; text: string} {
  const what = record.label, deadline = routerDeadline(record);
  if (!resolution) return record.phase === 'submitted' ? {stage: 'submitted', text: `${what}: submitted. Checking the network…`} : {stage: record.uncertain ? 'uncertain' : 'awaiting-wallet', text: `${what}: a wallet request was open. Checking what happened…`};
  switch (resolution.state) {
    case 'confirmed': return {stage: 'confirmed', text: `${what}: confirmed${resolution.repriced ? ' (after a speed-up in your wallet)' : ''}.`};
    case 'reverted': return {stage: 'reverted', text: `${what}: the transaction failed on-chain and changed nothing except the gas fee.`};
    case 'cancelled': return {stage: 'cancelled', text: `${what}: cancelled in your wallet. Nothing was swapped, approved or moved.`};
    case 'replaced': return {stage: 'replaced', text: `${what}: your wallet replaced it with a different transaction, so this request did not run. Review your balances before trying again.`};
    case 'expired': return {stage: 'expired', text: `${what}: the network's latest block is past its time limit${deadline !== null ? ` (${clock(deadline)})` : ''} and no matching transaction was found, so it can no longer execute. If your wallet still lists it as pending, it can only fail on-chain, costing gas. Trading is unlocked.`};
    case 'submitted': return {stage: 'submitted', text: (resolution.seen
      ? `${what}: submitted and still waiting for the network. Do not send it again. You can speed it up or cancel it in your wallet; this page will follow the result.`
      : `${what}: submitted, but the network does not show it at the moment. Check your wallet's activity list.${deadline !== null ? autoUnlock(deadline) : ''}`)
      + (resolution.dismissible ? trackingNote(record, resolution.seen) : '')};
    case 'awaiting': return {stage: record.uncertain ? 'uncertain' : 'awaiting-wallet', text: `${what}: ${record.kind === 'legacy' ? 'an earlier version of this page left this request open' : record.uncertain ? 'your wallet did not say whether it sent this request' : 'this request was open in your wallet'}. `
      + 'If the request is still open in your wallet, confirm or reject it there. No matching transaction has been found yet.'
      + (resolution.until !== null ? autoUnlock(resolution.until) : resolution.dismissible ? trackingNote(record, false) : '')};
  }
}
/** Label of the button that stops tracking a request. */
export const dismissLabel = (record: PendingRecord) => record.kind === 'legacy' ? 'Stop tracking this earlier request' : 'I rejected or closed it — stop tracking';
/** Status shown after the user stopped tracking a request. Again: not a claim that it was cancelled or did not run. */
export const dismissNotice = (record: PendingRecord) => `${record.label}: no longer tracked by this page. This did not cancel anything. If it is still open in your wallet or pending on the network, it may still go through${record.kind === 'approve' ? ' and set the spending limit shown there' : ''}; check your wallet's activity list.`;
