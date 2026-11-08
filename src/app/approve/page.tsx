import Link from "next/link";
import { listApprovals } from "@/lib/store";
import { ago } from "@/components/outcome";

export const dynamic = "force-dynamic";
export const metadata = { title: "owner · leash" };

const STATUS: Record<string, string> = {
  waiting_for_owner: "waiting for the owner",
  paid: "approved and paid",
  rejected: "rejected",
  failed: "paypal error",
};

export default async function ApprovePage() {
  const approvals = await listApprovals(30);
  const waiting = approvals.filter((a) => a.status === "waiting_for_owner");
  return (
    <article className="pt-14 pb-10 sm:pt-20">
      <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.02em] sm:text-[44px]">owner approvals</h1>
      <p className="mt-4 max-w-[600px] text-[16px] leading-relaxed text-slate">
        when the agent wants to pay someone off the vendor list, or more than the limit, it can only open a paypal
        order. the money moves only if the owner logs in to paypal and approves it. the agent has no paypal login.
      </p>
      <p className="mt-6 text-[14px] text-slate">{waiting.length} waiting</p>
      {approvals.length === 0 ? (
        <div className="mt-4 border-y border-line py-12 text-center text-[15px] text-slate">nothing has been sent to the owner yet.</div>
      ) : (
        <ol className="mt-4 border-t border-line">
          {approvals.map((a) => (
            <li key={a.id} className="border-b border-line">
              <Link
                href={`/approve/${a.id}`}
                className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 py-4 transition-colors hover:bg-sand/60 sm:grid-cols-[56px_1fr_120px_180px] sm:items-baseline sm:px-2"
              >
                <span className="num font-mono text-[12px] text-mute">{ago(a.createdAt)}</span>
                <span className="col-span-2 line-clamp-2 text-[15px] leading-snug sm:col-span-1 sm:line-clamp-1">
                  {a.reason}
                </span>
                <span className="num font-mono text-[14px]">${a.amountUsd.toFixed(2)}</span>
                <span className="text-right text-[13px] text-slate">{STATUS[a.status]}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
