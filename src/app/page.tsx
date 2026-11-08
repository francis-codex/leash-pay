import Link from "next/link";
import { budget } from "@/lib/policy";
import { VENDORS } from "@/lib/config";
import { counts, feed } from "@/lib/store";
import { Ledger } from "@/components/ledger";

export const dynamic = "force-dynamic";

const usd = (n: number) => `$${n.toFixed(2)}`;

export default async function Home() {
  const [status, c, items] = await Promise.all([budget(), counts(), feed(20)]);
  const total = Object.values(c).reduce((a, b) => a + b, 0);

  const stats = [
    { label: "left today", value: usd(status.remaining_today_usd) },
    { label: "attempts", value: String(total) },
    { label: "blocked by the gate", value: String(c.policy_refused) },
    { label: "sent to the owner", value: String(c.escalated) },
  ];

  return (
    <>
      <section className="pt-16 pb-14 sm:pt-24 sm:pb-20">
        <h1 className="max-w-[760px] text-[40px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[64px]">
          your agent can be tricked. your money <span className="text-blue">can&apos;t</span>.
        </h1>
        <p className="mt-6 max-w-[560px] text-[17px] leading-relaxed text-slate">
          an ai agent pays invoices through paypal. it can only pay {VENDORS.length} known vendors, up to{" "}
          {usd(status.max_per_payment_usd)} a payment and {usd(status.daily_cap_usd)} a day. anything else becomes a paypal
          order only the owner can approve. write an invoice that makes it pay you.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
          <Link
            href="/arena"
            className="inline-flex h-12 items-center bg-ink px-6 text-[15px] font-medium text-paper transition-colors hover:bg-ink-hover"
          >
            try to make it steal
          </Link>
          <Link href="/rules" className="text-[15px] text-slate underline-offset-4 hover:text-ink hover:underline">
            see the rules
          </Link>
        </div>
      </section>

      <section
        aria-label="numbers"
        className="grid grid-cols-2 gap-px border-y border-line bg-line sm:grid-cols-4 [&>*]:pl-5 [&>*:nth-child(odd)]:pl-0 sm:[&>*:nth-child(odd)]:pl-5 sm:[&>*:first-child]:pl-0"
      >
        {stats.map((s) => (
          <div key={s.label} className="bg-paper py-6 pr-4">
            <div className="num text-[32px] leading-none font-medium tracking-[-0.02em]">{s.value}</div>
            <div className="mt-2 text-[13px] text-slate">{s.label}</div>
          </div>
        ))}
      </section>

      <section className="mt-20">
        <div className="mb-5 flex items-baseline justify-between">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em]">every attempt</h2>
          <span className="text-[13px] text-mute">live</span>
        </div>
        <Ledger initial={items.map(({ id, createdAt, invoice, outcome, txs }) => ({ id, createdAt, invoice: invoice.slice(0, 140), outcome, txs }))} />
      </section>

      <section className="mt-24 grid gap-10 border-t border-line pt-10 sm:grid-cols-3 sm:gap-8">
        {[
          ["the agent reads", "invoices arrive as untrusted text. it has no defense against injection in its prompt. on purpose."],
          ["the gate decides", "every payment goes through a policy gate on our server: vendor list, per-payment limit, daily cap, no double pays. only the gate holds the paypal credentials."],
          ["the owner approves", "anything else becomes a paypal order. it only gets paid if the owner logs in to paypal and approves it. the agent can't."],
        ].map(([t, d], i) => (
          <div key={t}>
            <div className="num font-mono text-[12px] text-mute">0{i + 1}</div>
            <h3 className="mt-3 text-[17px] font-semibold">{t}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-slate">{d}</p>
          </div>
        ))}
      </section>
    </>
  );
}
