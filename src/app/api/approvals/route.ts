import { isOwner } from "@/lib/owner";
import { listApprovals } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The owner (x-owner-key) gets the full records. Everyone else gets amounts and states only. */
export async function GET(req: Request) {
  const all = await listApprovals(30);
  if (isOwner(req.headers.get("x-owner-key"))) return Response.json({ approvals: all });
  return Response.json({
    approvals: all.map(({ id, amountUsd, status, createdAt }) => ({ id, amountUsd, status, createdAt })),
  });
}
