import type { Step } from "@/lib/store";

const LABEL: Record<string, string> = {
  read_invoice: "read the invoice",
  list_vendors: "looked up vendors",
  get_balance: "checked the balance",
  pay: "tried to pay",
  request_approval: "asked the owner",
};

function summarize(name: string, v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  if (name === "pay" || name === "request_approval") {
    if ("to" in o) return `$${Number(o.amount_usd).toFixed(2)} → ${o.to}`;
    if (o.status === "paid") return `paid · paypal payout ${o.paypal_payout_batch_id}`;
    if (o.status === "refused_by_policy") return `${o.detail ?? o.reason}`;
    if (o.status === "waiting_for_owner") return `paypal order ${o.paypal_order_id} waiting for the owner`;
    if (o.status === "failed") return `failed · ${o.reason}`;
  }
  if (name === "get_balance" && "remaining_today_usd" in o) return `$${o.remaining_today_usd} left today, $${o.max_per_payment_usd} max per payment`;
  if (name === "list_vendors" && Array.isArray(o.vendors)) return `${o.vendors.length} vendors`;
  if (name === "read_invoice") return "";
  return "";
}

export function RunLog({ steps, running }: { steps: Step[]; running?: boolean }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        if (s.type === "text") {
          return (
            <li key={i} className="py-3 text-[15px] leading-relaxed [overflow-wrap:anywhere]">
              {s.text}
            </li>
          );
        }
        const refused =
          s.output && typeof s.output === "object" && (s.output as { status?: string }).status === "refused_by_wallet";
        const tx = s.output && typeof s.output === "object" ? (s.output as { tx?: string }).tx : undefined;
        const input = summarize(s.name, s.input);
        const output = summarize(s.name, s.output);
        return (
          <li key={i} className="grid grid-cols-[14px_1fr] gap-x-3 py-3">
            <span
              aria-hidden
              className={`mt-[7px] inline-block size-[7px] ${
                refused ? "bg-blue" : s.output === undefined ? "border border-mute" : "bg-ink"
              }`}
            />
            <div className="min-w-0">
              <div className="text-[14px] font-medium">
                {LABEL[s.name] ?? s.name}
                {s.output === undefined && running && <span className="ml-2 font-normal text-mute">working…</span>}
              </div>
              {input && <div className="mt-1 font-mono text-[12px] break-all text-slate">{input}</div>}
              {output && (
                <div className={`mt-1 font-mono text-[12px] break-words ${refused ? "text-blue-ink" : "text-slate"}`}>
                  {output}
                  {tx && (
                    <>
                      {" · "}
                      <a href={tx} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        paypal
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
