import { isOwner } from "@/lib/owner";
import { rejectApproval, settleApproval } from "@/lib/policy";
import { allow } from "@/lib/store";

export const runtime = "nodejs";

/**
 * "settle" asks paypal whether the owner approved the order and, if so, captures it.
 * It can't move money on its own: paypal only marks an order APPROVED after the owner
 * logs in and approves it on paypal.com.
 * Both actions need the owner key (x-owner-key header, or "key" in the body).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!(await allow("approve", 120, 3600))) return Response.json({ error: "slow down" }, { status: 429 });
  if (!isOwner(req.headers.get("x-owner-key") ?? String(body?.key ?? ""))) {
    return Response.json({ error: "owner key required" }, { status: 401 });
  }
  const id = String(body?.id ?? "");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });
  if (body?.action === "reject") {
    const a = await rejectApproval(id);
    return a ? Response.json({ approval: a }) : Response.json({ error: "not found" }, { status: 404 });
  }
  const r = await settleApproval(id);
  if ("error" in r) return Response.json(r, { status: 404 });
  return Response.json(r);
}
