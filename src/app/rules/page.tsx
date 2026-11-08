import { budget } from "@/lib/policy";
import { paypalMode } from "@/lib/paypal";
import { MAX_APPROVAL_USD, VENDORS } from "@/lib/config";
import { isPaused } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "rules · leash" };

function Row({ k, v, href }: { k: string; v: string; href?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-b border-line py-3 sm:grid-cols-[220px_1fr]">
      <dt className="text-[14px] text-slate">{k}</dt>
      <dd className="min-w-0 text-right font-mono text-[13px] sm:text-left">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-4 hover:decoration-ink">
            <span className="break-all">{v}</span>
          </a>
        ) : (
          v
        )}
      </dd>
    </div>
  );
}

export default async function Rules() {
  const [b, paused] = await Promise.all([budget(), isPaused()]);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return (
    <div className="max-w-[760px] pt-14 pb-10 sm:pt-20">
      <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.02em] sm:text-[44px]">the rules</h1>
      <p className="mt-4 text-[16px] leading-relaxed text-slate">
        the agent never holds paypal credentials. it can call two tools that move money, and both go through a policy
        gate on our server. here is exactly what the gate enforces, and what paypal enforces.
      </p>

      <section className="mt-12">
        <h2 className="text-[17px] font-semibold">the agent can, on its own</h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-slate">
          <li>pay one of the {VENDORS.length} vendors below through paypal payouts</li>
          <li>up to {usd(b.max_per_payment_usd)} per payment, {usd(b.daily_cap_usd)} a day in total</li>
          <li>each payment once: a retry of the same invoice is refused, and paypal&apos;s sender_batch_id blocks a repeat too</li>
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-[17px] font-semibold">everything else</h2>
        <p className="mt-4 text-[15px] leading-relaxed text-slate">
          becomes a paypal order (up to {usd(MAX_APPROVAL_USD)}, once per invoice). it only gets paid if the owner logs
          in to paypal and approves it. that step is enforced by paypal, not by us: the agent has no paypal login.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-[17px] font-semibold">right now</h2>
        <dl className="mt-4 border-t border-line">
          <Row k="paypal" v={paypalMode()} />
          <Row k="kill switch" v={paused ? "paused: every payment refused" : "running"} />
          <Row k="spent today" v={usd(b.spent_today_usd)} />
          <Row k="left today" v={usd(b.remaining_today_usd)} />
          {VENDORS.map((v) => (
            <Row key={v.email} k={v.name} v={v.email} />
          ))}
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="text-[17px] font-semibold">honest limits</h2>
        <p className="mt-4 text-[15px] leading-relaxed text-slate">
          the vendor list, per-payment limit, daily cap and the owner&apos;s kill switch are enforced by our server, not by
          paypal. every payment carries the agent&apos;s one-sentence reason; its sha256 is written into the paypal payout
          note or order description, so paypal&apos;s copy can be checked against the reason shown here. if you can get money
          to a paypal account that isn&apos;t listed, or past the limits, without the owner approving it on paypal, you
          broke it. tell us.
        </p>
      </section>
    </div>
  );
}
