import { budget } from "@/lib/policy";
import { paypalMode } from "@/lib/paypal";
import { MAX_APPROVAL_USD, VENDORS } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    paypal: paypalMode(),
    ...(await budget()),
    max_approval_usd: MAX_APPROVAL_USD,
    vendors: VENDORS,
  });
}
