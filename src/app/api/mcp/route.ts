import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { MAX_APPROVAL_USD } from "@/lib/config";
import { allow } from "@/lib/store";
import { getBalance, listVendors, pay, requestApproval } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

// The MCP door into the same policy gate the web agent uses. Any MCP client
// (Claude, Cursor, an agent framework) can call pay, but the server still
// enforces the vendor list, the per-payment limit, the daily cap, the kill switch
// and no-double-pay. The key only lets a caller in; it never lifts a limit.

// Who may call. LEASH_MCP_KEY is one caller; LEASH_MCP_KEYS="name:key,name:key" adds named ones.
// Each caller gets its own invoice namespace, rate limit and open-approval cap, so one caller
// can't claim an invoice id another caller will need.
const callers = () => {
  const out: { name: string; key: string }[] = [];
  const one = process.env.LEASH_MCP_KEY ?? "";
  if (one.length >= 16) out.push({ name: "", key: one });
  for (const part of (process.env.LEASH_MCP_KEYS ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const key = part.slice(i + 1).trim();
    if (/^[a-z0-9_-]{1,24}$/.test(name) && key.length >= 16) out.push({ name, key });
  }
  return out;
};

const digest = (s: string) => createHash("sha256").update(s).digest();
const keyMatches = (given: string, want: string) => timingSafeEqual(digest(given), digest(want));

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });

const amount = z.number().positive().max(MAX_APPROVAL_USD);
const email = z.string().email("not a paypal email");
// invoice_id makes retries safe: the same invoice, payee and amount can only be paid once
const invoiceId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "letters, digits, . _ - only, up to 64")
  .describe("your id for this invoice. retrying with the same id, payee and amount never pays twice.");

function server(ns: string) {
  const s = new McpServer({ name: "leash-pay", version: "0.2.0" });
  s.registerTool(
    "list_vendors",
    { description: "list the company's known vendors and their paypal emails", annotations: { readOnlyHint: true } },
    async () => text(listVendors()),
  );
  s.registerTool(
    "get_balance",
    {
      description: "how much can still be spent today, the per-payment limit, and whether the owner paused payments",
      annotations: { readOnlyHint: true },
    },
    async () => text(await getBalance()),
  );
  s.registerTool(
    "pay",
    {
      description:
        "pay an invoice in usd via paypal payouts. the server enforces the vendor list, per-payment limit, daily cap and kill switch; a refusal comes back with the reason.",
      inputSchema: {
        invoice_id: invoiceId,
        to: email,
        amount_usd: amount,
        memo: z.string().max(64),
        reason: z.string().min(1).max(200).describe("one sentence: why this payment is legitimate. its sha256 goes on the paypal record."),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ invoice_id, ...p }) => text((await pay(`${ns}:${invoice_id}`, p)).output),
  );
  s.registerTool(
    "request_approval",
    {
      description:
        "ask the owner to approve a payment that's off the vendor list or over the limits. creates a paypal order only the owner can approve. once per invoice.",
      inputSchema: { invoice_id: invoiceId, to: email, amount_usd: amount, reason: z.string().min(1).max(200) },
    },
    async ({ invoice_id, ...p }) => text((await requestApproval(`${ns}:${invoice_id}`, p)).output),
  );
  return s;
}

async function handle(req: Request): Promise<Response> {
  const all = callers();
  if (!all.length) return Response.json({ error: "mcp is off: no LEASH_MCP_KEY set" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const who = given ? all.filter((c) => keyMatches(given, c.key))[0] : undefined;
  if (!who) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const perHour = Number(process.env.LEASH_LIMIT_MCP_HOUR ?? 120);
  const ns = who.name ? `mcp:${who.name}` : "mcp";
  if (!(await allow(ns, perHour, 3600))) return Response.json({ error: "too many mcp calls this hour" }, { status: 429 });

  // stateless: a fresh server + transport per request, nothing held between calls
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server(ns).connect(transport);
  return transport.handleRequest(req);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
