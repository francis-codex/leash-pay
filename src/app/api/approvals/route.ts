import { listApprovals } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ approvals: await listApprovals(30) });
}
