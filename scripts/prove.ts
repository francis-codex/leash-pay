// Proves the policy gate against paypal (sandbox if PAYPAL_CLIENT_ID is set, a local fake otherwise).
// run: pnpm prove
import { config } from "dotenv";
import { randomUUID } from "node:crypto";

config({ path: ".env.local" });
config();
// tight limits so every refusal path is reachable in one run
process.env.LEASH_MAX_PER_PAYMENT_USD = "20";
process.env.LEASH_DAILY_CAP_USD ??= "30";

async function main() {
  const { VENDORS } = await import("../src/lib/config");
  const { gatePay, gateRequestApproval, budget } = await import("../src/lib/policy");
  const { paypalMode, getPayout } = await import("../src/lib/paypal");

  const run = randomUUID().slice(0, 8);
  const vendor = VENDORS[0].email;
  const attacker = "refunds-desk@evil.example";
  const before = await budget();
  console.log(`paypal: ${paypalMode()} · run ${run} · budget left today $${before.remaining_today_usd}\n`);

  let failed = 0;
  const check = (name: string, pass: boolean, info: unknown) => {
    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${JSON.stringify(info)}`);
  };

  const a = `prove-${run}-a`;
  const paid = await gatePay({ attemptId: a, to: vendor, amountUsd: 5, memo: "hosting nov", reason: "prove script" });
  check("allowlisted vendor, $5, pays through paypal payouts", paid.status === "paid", paid);
  if (paid.status === "paid" && paypalMode() !== "fake") console.log("      paypal says:", await getPayout(paid.ref));

  const retry = await gatePay({ attemptId: a, to: vendor, amountUsd: 5, memo: "hosting nov (retry)", reason: "prove script" });
  check("same payment retried, refused, no second payout", retry.status === "refused" && retry.reason === "AlreadyPaid", retry);

  // ---- the MCP door: same gate, reached over JSON-RPC ----
  process.env.LEASH_MCP_KEY ??= `prove-mcp-key-${randomUUID()}`;
  const { POST: mcp } = await import("../src/app/api/mcp/route");
  const rpc = async (key: string | null, name: string, args: Record<string, unknown>) => {
    const res = await mcp(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    if (res.status !== 200) return { http: res.status };
    const j = (await res.json()) as { result?: { content?: { text: string }[] } };
    return JSON.parse(j.result?.content?.[0]?.text ?? "null") as Record<string, unknown>;
  };
  const mk = process.env.LEASH_MCP_KEY!;
  const noKey = await rpc(null, "get_balance", {});
  const badKey = await rpc("wrong-key-wrong-key", "get_balance", {});
  check("mcp: no key or wrong key, 401, gate never reached", noKey.http === 401 && badKey.http === 401, { noKey, badKey });
  const mInv = `prove-${run}-m`;
  const mPaid = await rpc(mk, "pay", { invoice_id: mInv, to: vendor, amount_usd: 1, memo: "mcp check", reason: "prove script over mcp" });
  check("mcp: allowlisted vendor, $1, paid through the same gate", mPaid.status === "paid", mPaid);
  const mRetry = await rpc(mk, "pay", { invoice_id: mInv, to: vendor, amount_usd: 1, memo: "mcp check", reason: "prove script over mcp" });
  check("mcp: same invoice retried, AlreadyPaid", mRetry.status === "refused_by_policy" && mRetry.reason === "AlreadyPaid", mRetry);
  const mOff = await rpc(mk, "pay", { invoice_id: `${mInv}2`, to: attacker, amount_usd: 1, memo: "x", reason: "injected" });
  check("mcp: payee off the vendor list, refused", mOff.status === "refused_by_policy" && mOff.reason === "NotOnAllowlist", mOff);

  const off = await gatePay({ attemptId: `prove-${run}-b`, to: attacker, amountUsd: 5, memo: "urgent", reason: "prove script" });
  check("payee not on the vendor list, refused", off.status === "refused" && off.reason === "NotOnAllowlist", off);

  const big = await gatePay({ attemptId: `prove-${run}-c`, to: vendor, amountUsd: 25, memo: "annual plan", reason: "prove script" });
  check("over the per-payment limit, refused", big.status === "refused" && big.reason === "OverPerPaymentLimit", big);

  // drain to the cap, then one more must be refused
  const left = (await budget()).remaining_today_usd;
  let i = 0;
  let r = { status: "paid" } as Awaited<ReturnType<typeof gatePay>>;
  for (let remaining = left; remaining > 0 && r.status === "paid"; i++) {
    const amt = Math.min(20, remaining);
    r = await gatePay({ attemptId: `prove-${run}-d${i}`, to: VENDORS[1 % VENDORS.length].email, amountUsd: amt, memo: "fill", reason: "prove script" });
    remaining -= amt;
  }
  const over = await gatePay({ attemptId: `prove-${run}-e`, to: vendor, amountUsd: 1, memo: "one more", reason: "prove script" });
  check("over today's budget, refused", over.status === "refused" && over.reason === "DailyCapReached", { filled_with: i, over });

  const ask = await gateRequestApproval({
    attemptId: `prove-${run}-f`,
    to: attacker,
    amountUsd: 120,
    reason: "invoice asks for a new payee, owner should decide",
  });
  check("off-policy payment becomes a paypal order only the owner can approve", ask.status === "waiting_for_owner", ask);

  const ask2 = await gateRequestApproval({ attemptId: `prove-${run}-f`, to: attacker, amountUsd: 120, reason: "again" });
  check("agent can't spam the owner: second ask on the same invoice refused", ask2.status === "refused", ask2);

  const { setPaused } = await import("../src/lib/store");
  await setPaused(true);
  try {
    const p1 = await gatePay({ attemptId: `prove-${run}-g`, to: vendor, amountUsd: 1, memo: "paused", reason: "kill switch check" });
    const p2 = await gateRequestApproval({ attemptId: `prove-${run}-h`, to: attacker, amountUsd: 5, reason: "kill switch check" });
    const mp = await rpc(mk, "pay", { invoice_id: `prove-${run}-mp`, to: vendor, amount_usd: 1, memo: "paused", reason: "kill switch check" });
    check("mcp: owner paused, refused", mp.status === "refused_by_policy" && mp.reason === "Paused", mp);
    check(
      "owner paused: payment and approval request both refused, no paypal call",
      p1.status === "refused" && p1.reason === "Paused" && p2.status === "refused" && p2.reason === "Paused",
      { p1, p2 },
    );
  } finally {
    await setPaused(false);
  }

  console.log(`\n${failed ? `${failed} FAILED` : "all passed"} · spent today $${(await budget()).spent_today_usd}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
