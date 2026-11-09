import "server-only";
import { VENDORS } from "./config";
import { isPaused } from "./store";
import { budget, gatePay, gateRequestApproval, reasonHash, type GateResult } from "./policy";

// One implementation of every money action. The web agent and the MCP server both
// call these, so both reach the same policy gate with the same limits.

export const listVendors = () => ({
  vendors: VENDORS.map(({ name, email }) => ({ name, paypal_email: email })),
});

export const getBalance = async () => ({ ...(await budget()), paused_by_owner: await isPaused() });

export type ToolOutcome = { output: Record<string, unknown>; result: GateResult };

export async function pay(
  attemptId: string,
  p: { to: string; amount_usd: number; memo: string; reason: string },
): Promise<ToolOutcome> {
  const result = await gatePay({
    attemptId,
    to: p.to,
    amountUsd: p.amount_usd,
    memo: `leash:${attemptId}:${p.memo}`,
    reason: p.reason,
  });
  const reason_sha256 = reasonHash(p.reason);
  if (result.ok) return { result, output: { status: "paid", paypal_payout_batch_id: result.ref, reason_sha256 } };
  return {
    result,
    output: {
      status: result.status === "refused" ? "refused_by_policy" : "failed",
      reason: result.reason,
      detail: result.detail,
      reason_sha256,
    },
  };
}

export async function requestApproval(
  attemptId: string,
  p: { to: string; amount_usd: number; reason: string },
): Promise<ToolOutcome> {
  const result = await gateRequestApproval({ attemptId, to: p.to, amountUsd: p.amount_usd, reason: p.reason });
  const reason_sha256 = reasonHash(p.reason);
  if (result.ok) return { result, output: { status: "waiting_for_owner", paypal_order_id: result.ref, reason_sha256 } };
  return {
    result,
    output: {
      status: result.status === "refused" ? "refused_by_policy" : "failed",
      reason: result.reason,
      detail: result.detail,
      reason_sha256,
    },
  };
}
