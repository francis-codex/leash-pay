import Link from "next/link";
import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { allow, isPaused, listApprovals, setPaused } from "@/lib/store";
import { ago } from "@/components/outcome";

const ownerKey = () => {
  const k = process.env.LEASH_OWNER_KEY ?? "";
  return k.length >= 16 ? k : null; // short or missing key = kill switch can't be flipped from the web
};

async function toggle(form: FormData) {
  "use server";
  const key = ownerKey();
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!key || !(await allow(`owner:${ip}`, 10, 3600))) redirect("/approve?owner=locked");
  const given = Buffer.from(String(form.get("key") ?? ""));
  const want = Buffer.from(key);
  if (given.length !== want.length || !timingSafeEqual(given, want)) redirect("/approve?owner=wrong");
  await setPaused(form.get("pause") === "1");
  revalidatePath("/", "layout");
  redirect("/approve");
}

const NOTE: Record<string, string> = {
  wrong: "wrong owner key. nothing changed.",
  locked: "the kill switch is locked: no owner key is set, or too many tries this hour.",
};

export const dynamic = "force-dynamic";
export const metadata = { title: "owner · leash" };

const STATUS: Record<string, string> = {
  waiting_for_owner: "waiting for the owner",
  paid: "approved and paid",
  rejected: "rejected",
  failed: "paypal error",
};

export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const [approvals, paused, sp] = await Promise.all([listApprovals(30), isPaused(), searchParams]);
  const note = sp.owner ? NOTE[sp.owner] : undefined;
  const waiting = approvals.filter((a) => a.status === "waiting_for_owner");
  return (
    <article className="pt-14 pb-10 sm:pt-20">
      <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.02em] sm:text-[44px]">owner approvals</h1>
      <p className="mt-4 max-w-[600px] text-[16px] leading-relaxed text-slate">
        when the agent wants to pay someone off the vendor list, or more than the limit, it can only open a paypal
        order. the money moves only if the owner logs in to paypal and approves it. the agent has no paypal login.
      </p>
      <section aria-label="kill switch" className="mt-10 border-y border-line py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h2 className="text-[17px] font-semibold">kill switch</h2>
            <p className="mt-1 text-[14px] text-slate">
              {paused
                ? "paused. the gate refuses every payment and every approval request."
                : "running. the agent can pay inside the rules."}
            </p>
          </div>
          <span className={`inline-flex items-center gap-2 text-[13px] ${paused ? "text-blue-ink" : "text-slate"}`}>
            <span aria-hidden className={`inline-block size-2 ${paused ? "bg-blue" : "bg-slate"}`} />
            {paused ? "paused" : "running"}
          </span>
        </div>
        <form action={toggle} className="mt-4 flex flex-wrap gap-3">
          <input type="hidden" name="pause" value={paused ? "0" : "1"} />
          <label className="sr-only" htmlFor="owner-key">owner key</label>
          <input
            id="owner-key"
            name="key"
            type="password"
            required
            autoComplete="off"
            placeholder="owner key"
            className="h-11 min-w-0 flex-1 border border-line bg-paper px-3 font-mono text-[14px] outline-none focus:border-ink sm:max-w-[320px]"
          />
          <button className="h-11 bg-ink px-5 text-[15px] font-medium text-paper transition-colors hover:bg-ink-hover">
            {paused ? "resume payments" : "pause all payments"}
          </button>
        </form>
        {note && <p className="mt-3 text-[13px] text-blue-ink">{note}</p>}
      </section>

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
