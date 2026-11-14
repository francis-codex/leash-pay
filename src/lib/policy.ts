import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { APP_URL, DAILY_CAP_USD, MAX_APPROVAL_USD, MAX_OPEN_APPROVALS, MAX_PER_PAYMENT_USD, isVendor } from "./config";
import { PayPalError, captureOrder, createOrder, createPayout, getOrder } from "./paypal";
import {
  claimOnce,
  getRecord,
  isPaused,
  listApprovals,
  putRecord,
  releaseSpend,
  reserveSpend,
  saveApproval,
  updateApproval,
  spentTodayCents,
  type Approval,
} from "./store";

/**
 * The policy gate. It sits between the agent and paypal: the agent calls these
 * functions through its tools, and only this file holds a path to the paypal rail.
 * Limits are enforced here, on our server, before any paypal call is made.
 */

export type DenyReason =
  | "Paused"
  | "InvalidAmount"
  | "NotOnAllowlist"
  | "OverPerPaymentLimit"
  | "DailyCapReached"
  | "AlreadyPaid"
  | "OverApprovalLimit"
  | "AlreadyAsked"
  | "TooManyOpen";

export const DENY_DETAIL: Record<DenyReason, string> = {
  Paused: "the gate refused: the owner paused all payments",
  InvalidAmount: "the gate refused: that amount isn't a valid payment",
  NotOnAllowlist: "the gate refused: this payee is not on the owner's vendor list",
  OverPerPaymentLimit: `the gate refused: payments over $${MAX_PER_PAYMENT_USD} need the owner`,
  DailyCapReached: `the gate refused: this would go over today's $${DAILY_CAP_USD} budget`,
  AlreadyPaid: "the gate refused: this exact payment was already made",
  OverApprovalLimit: `the gate refused: amounts over $${MAX_APPROVAL_USD} can't even be requested`,
  AlreadyAsked: "the gate refused: the owner was already asked once for this invoice",
  TooManyOpen: `the gate refused: ${MAX_OPEN_APPROVALS} requests from this caller are already waiting for the owner`,
};

/** sha256 of the agent's stated reason. it goes into the paypal record, so paypal's copy can be checked against the reason we show. */
export const reasonHash = (reason: string) => createHash("sha256").update(reason.trim()).digest("hex");

export type GateResult =
  | { ok: true; status: "paid"; ref: string; batchId: string; paypalStatus: string }
  | { ok: true; status: "waiting_for_owner"; approvalId: string; ref: string; link?: string }
  | { ok: false; status: "refused"; reason: DenyReason; detail: string }
  | { ok: false; status: "failed"; reason: string; detail: string; debugId?: string };

const toCents = (usd: number) => Math.round(usd * 100);
const validAmount = (usd: number) =>
  Number.isFinite(usd) && usd > 0 && Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-6;
const deny = (reason: DenyReason): GateResult => ({ ok: false, status: "refused", reason, detail: DENY_DETAIL[reason] });

/** Same attempt + payee + amount = same payment. Retries can't pay twice. */
export const paymentKey = (attemptId: string, to: string, usd: number) =>
  `${attemptId}:${to.trim().toLowerCase()}:${toCents(usd)}`;

const batchIdFor = (key: string) => `leash-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

export async function gatePay(p: {
  attemptId: string;
  to: string;
  amountUsd: number;
  memo: string;
  reason: string;
}): Promise<GateResult> {
  if (await isPaused()) return deny("Paused");
  if (!validAmount(p.amountUsd)) return deny("InvalidAmount");
  if (!isVendor(p.to)) return deny("NotOnAllowlist");
  if (p.amountUsd > MAX_PER_PAYMENT_USD) return deny("OverPerPaymentLimit");

  const cents = toCents(p.amountUsd);
  if ((await reserveSpend(cents, toCents(DAILY_CAP_USD))) === null) return deny("DailyCapReached");

  const key = paymentKey(p.attemptId, p.to, p.amountUsd);
  if (!(await claimOnce(`pay:${key}`))) {
    await releaseSpend(cents);
    return deny("AlreadyPaid");
  }

  const batchId = batchIdFor(key);
  try {
    const hash = reasonHash(p.reason);
    const r = await createPayout({ batchId, email: p.to.trim(), amount: p.amountUsd, note: `${p.memo} | reason sha256:${hash}` });
    await putRecord(`payout:${batchId}`, { ...r, key, to: p.to, amountUsd: p.amountUsd, reason: p.reason, reasonHash: hash, at: Date.now() });
    return { ok: true, status: "paid", ref: r.payoutBatchId, batchId, paypalStatus: r.status };
  } catch (e) {
    // A 4xx means paypal did not move money: give the budget back. On 5xx or a network
    // error we keep it reserved, since the payout may have gone through; the batch id stays
    // claimed so a retry can't double-pay.
    const definite = e instanceof PayPalError && ((e.status >= 400 && e.status < 500) || e.name === "PAYPAL_NOT_CONFIGURED");
    if (definite) await releaseSpend(cents);
    return {
      ok: false,
      status: "failed",
      reason: e instanceof PayPalError ? e.name : "PAYPAL_UNREACHABLE",
      detail: e instanceof Error ? e.message : String(e),
      debugId: e instanceof PayPalError ? e.debugId : undefined,
    };
  }
}

/** mcp:<invoice> -> "mcp", mcp:<name>:<invoice> -> "mcp:<name>", everything else is the web agent. */
const callerOf = (attemptId: string) =>
  attemptId.startsWith("mcp:") ? attemptId.slice(0, attemptId.lastIndexOf(":")) : "web";
const OPEN_FOR_MS = 72 * 3600 * 1000; // an unanswered request stops counting after 3 days

/**
 * Anything the gate won't pay becomes a paypal order. Only the owner can approve it,
 * by logging in to paypal; the agent holds no paypal login and no approve path.
 */
export async function gateRequestApproval(p: {
  attemptId: string;
  to: string;
  amountUsd: number;
  reason: string;
}): Promise<GateResult> {
  if (await isPaused()) return deny("Paused");
  if (!validAmount(p.amountUsd)) return deny("InvalidAmount");
  if (p.amountUsd > MAX_APPROVAL_USD) return deny("OverApprovalLimit");
  const caller = callerOf(p.attemptId);
  const open = (await listApprovals(200)).filter(
    (a) => a.status === "waiting_for_owner" && callerOf(a.attemptId) === caller && Date.now() - a.createdAt < OPEN_FOR_MS,
  );
  if (open.length >= MAX_OPEN_APPROVALS) return deny("TooManyOpen");
  if (!(await claimOnce(`ask:${p.attemptId}`))) return deny("AlreadyAsked");

  const id = randomUUID();
  const base: Approval = {
    id,
    attemptId: p.attemptId,
    to: p.to.trim(),
    amountUsd: p.amountUsd,
    reason: p.reason,
    reasonHash: reasonHash(p.reason),
    createdAt: Date.now(),
    status: "waiting_for_owner",
  };
  try {
    const o = await createOrder({
      requestId: `leash-ask-${id}`,
      amount: p.amountUsd,
      payeeEmail: base.to,
      description: `leash sha256:${base.reasonHash!.slice(0, 16)} ${p.reason}`,
      returnUrl: `${APP_URL}/approve/${id}?paypal=return`,
      cancelUrl: `${APP_URL}/approve/${id}?paypal=cancel`,
    });
    await saveApproval({ ...base, orderId: o.orderId, approveUrl: o.approveUrl });
    return { ok: true, status: "waiting_for_owner", approvalId: id, ref: o.orderId, link: `${APP_URL}/approve/${id}` };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await saveApproval({ ...base, status: "failed", error: detail });
    return { ok: false, status: "failed", reason: e instanceof PayPalError ? e.name : "PAYPAL_UNREACHABLE", detail };
  }
}

export async function budget() {
  const spent = (await spentTodayCents()) / 100;
  return {
    daily_cap_usd: DAILY_CAP_USD,
    spent_today_usd: spent,
    remaining_today_usd: Math.max(0, DAILY_CAP_USD - spent),
    max_per_payment_usd: MAX_PER_PAYMENT_USD,
  };
}

export const getPayoutRecord = (batchId: string) => getRecord(`payout:${batchId}`);

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const terminal = (e: unknown) => e instanceof PayPalError && e.status >= 400 && e.status < 500;

/**
 * Settles an owner approval. Money only moves if paypal says the owner approved the
 * order in their own paypal login; calling this without that does nothing.
 */
export async function settleApproval(id: string) {
  const a = await getRecord<Approval>(`approval:${id}`);
  if (!a) return { error: "not found" as const };
  if (a.status !== "waiting_for_owner" || !a.orderId) return { approval: a };
  let o: { status: string };
  try {
    o = await getOrder(a.orderId);
  } catch (e) {
    if (terminal(e)) return { approval: await updateApproval(id, { status: "failed", error: msg(e) }) };
    return { approval: await updateApproval(id, { error: `will retry: ${msg(e)}` }), paypalStatus: "UNREACHABLE" };
  }
  if (o.status === "COMPLETED") return { approval: await updateApproval(id, { status: "paid" }) };
  if (o.status !== "APPROVED") return { approval: a, paypalStatus: o.status };
  try {
    const c = await captureOrder(a.orderId);
    return { approval: await updateApproval(id, c.status === "COMPLETED" ? { status: "paid", captureId: c.captureId } : {}) };
  } catch (e) {
    // only a definite paypal "no" ends it. a timeout, a 5xx or a config gap leaves the request
    // waiting, so the next settle (owner reloads the page, or POST /api/approve) tries again.
    if (terminal(e)) return { approval: await updateApproval(id, { status: "failed", error: msg(e) }) };
    return { approval: await updateApproval(id, { error: `will retry: ${msg(e)}` }), paypalStatus: "RETRY" };
  }
}

export async function rejectApproval(id: string) {
  const a = await getRecord<Approval>(`approval:${id}`);
  if (!a) return null;
  if (a.status !== "waiting_for_owner") return a;
  return updateApproval(id, { status: "rejected" });
}
