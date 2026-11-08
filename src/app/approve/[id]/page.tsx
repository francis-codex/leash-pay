import Link from "next/link";
import { notFound } from "next/navigation";
import { getRecord, type Approval } from "@/lib/store";
import { settleApproval } from "@/lib/policy";
import { isVendor } from "@/lib/config";
import { Decide } from "./decide";

export const dynamic = "force-dynamic";
export const metadata = { title: "approval · leash" };

export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ paypal?: string }>;
}) {
  const { id } = await params;
  const { paypal } = await searchParams;
  let a = await getRecord<Approval>(`approval:${id}`);
  if (!a) notFound();
  // back from paypal: ask paypal whether the owner approved, and capture if so
  if (paypal === "return" && a.status === "waiting_for_owner") a = (await settleApproval(id)).approval ?? a;

  const known = isVendor(a.to);
  return (
    <article className="max-w-[720px] pt-14 pb-10 sm:pt-20">
      <Link href="/approve" className="text-[14px] text-slate hover:text-ink">← all approvals</Link>
      <h1 className="mt-6 text-[32px] leading-tight font-semibold tracking-[-0.02em] sm:text-[40px]">
        the agent wants to pay ${a.amountUsd.toFixed(2)}
      </h1>
      <dl className="mt-8 border-t border-line text-[15px]">
        {[
          ["to", `${a.to}${known ? " (a known vendor)" : " (not on the vendor list)"}`],
          ["why, in the agent's words", a.reason],
          ["paypal order", a.orderId ?? "none"],
          ["status", a.status.replaceAll("_", " ")],
          ...(a.captureId ? [["paypal capture", a.captureId]] : []),
          ...(a.error ? [["error", a.error]] : []),
        ].map(([k, v]) => (
          <div key={k} className="grid gap-1 border-b border-line py-3 sm:grid-cols-[200px_1fr]">
            <dt className="text-slate">{k}</dt>
            <dd className="font-mono text-[13px] break-all">{v}</dd>
          </div>
        ))}
      </dl>
      {paypal === "cancel" && a.status === "waiting_for_owner" && (
        <p className="mt-6 text-[14px] text-slate">you left paypal without approving. nothing moved.</p>
      )}
      {a.status === "waiting_for_owner" && <Decide id={a.id} approveUrl={a.approveUrl} />}
    </article>
  );
}
