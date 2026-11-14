import "server-only";
import { randomUUID } from "node:crypto";

// PayPal REST, sandbox by default. The agent never sees these credentials:
// only the policy gate (policy.ts) calls into this file.
const BASE =
  process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

/** "disabled" = production with no paypal credentials: status pages still load, money calls refuse. */
export function paypalMode(): "sandbox" | "live" | "fake" | "disabled" {
  if (process.env.PAYPAL_CLIENT_ID) return process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
  if (process.env.NODE_ENV === "production") return "disabled";
  return "fake";
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public name: string,
    message: string,
    public debugId?: string,
  ) {
    super(message);
  }
}

let token: { value: string; exp: number } | undefined;

async function accessToken(): Promise<string> {
  if (paypalMode() === "disabled") {
    throw new PayPalError(503, "PAYPAL_NOT_CONFIGURED", "paypal is off: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set");
  }
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new PayPalError(res.status, "AUTH_FAILED", "paypal rejected the app credentials");
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const details = (j.details as { issue?: string; description?: string }[] | undefined)?.[0];
    throw new PayPalError(
      res.status,
      String(details?.issue ?? j.name ?? "PAYPAL_ERROR"),
      String(details?.description ?? j.message ?? `paypal returned ${res.status}`),
      j.debug_id as string | undefined,
    );
  }
  return j as T;
}

const usd = (n: number) => n.toFixed(2);

// ---------- Payouts: the agent's within-policy rail ----------

export type Payout = { batchId: string; payoutBatchId: string; status: string };

/** sender_batch_id doubles as the idempotency key: paypal refuses to reuse one. */
export async function createPayout(p: { batchId: string; email: string; amount: number; note: string }): Promise<Payout> {
  if (paypalMode() === "fake") return fake.payout(p);
  const r = await call<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
    "POST",
    "/v1/payments/payouts",
    {
      sender_batch_header: { sender_batch_id: p.batchId, email_subject: "you have a payment from leash" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: p.email,
          amount: { value: usd(p.amount), currency: "USD" },
          note: p.note.slice(0, 4000),
          sender_item_id: p.batchId,
        },
      ],
    },
    p.batchId,
  );
  return { batchId: p.batchId, payoutBatchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status };
}

export async function getPayout(payoutBatchId: string): Promise<{ status: string; itemStatus?: string }> {
  if (paypalMode() === "fake") return { status: "SUCCESS", itemStatus: "SUCCESS" };
  const r = await call<{ batch_header: { batch_status: string }; items?: { transaction_status?: string }[] }>(
    "GET",
    `/v1/payments/payouts/${payoutBatchId}`,
  );
  return { status: r.batch_header.batch_status, itemStatus: r.items?.[0]?.transaction_status };
}

// ---------- Orders: the owner-only rail ----------

export type Order = { orderId: string; status: string; approveUrl?: string };

/** An order only the owner can approve, by logging in to paypal. The agent has no way to. */
export async function createOrder(p: {
  requestId: string;
  amount: number;
  payeeEmail: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}): Promise<Order> {
  if (paypalMode() === "fake") return fake.order(p);
  const r = await call<{ id: string; status: string; links: { rel: string; href: string }[] }>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: p.requestId.slice(0, 256),
          custom_id: p.requestId.slice(0, 127),
          description: p.description.slice(0, 127),
          amount: { currency_code: "USD", value: usd(p.amount) },
          payee: { email_address: p.payeeEmail },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "leash",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: p.returnUrl,
            cancel_url: p.cancelUrl,
          },
        },
      },
    },
    p.requestId,
  );
  const approveUrl = r.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  return { orderId: r.id, status: r.status, approveUrl };
}

export async function getOrder(orderId: string): Promise<{ status: string }> {
  if (paypalMode() === "fake") return { status: fake.orders.get(orderId) ?? "PAYER_ACTION_REQUIRED" };
  const r = await call<{ status: string }>("GET", `/v2/checkout/orders/${orderId}`);
  return { status: r.status };
}

export async function captureOrder(orderId: string): Promise<{ status: string; captureId?: string }> {
  if (paypalMode() === "fake") {
    fake.orders.set(orderId, "COMPLETED");
    return { status: "COMPLETED", captureId: `FAKE-CAP-${orderId}` };
  }
  const r = await call<{
    status: string;
    purchase_units?: { payments?: { captures?: { id: string }[] } }[];
  }>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, `capture-${orderId}`);
  return { status: r.status, captureId: r.purchase_units?.[0]?.payments?.captures?.[0]?.id };
}

// ---------- local fake (dev only, no credentials) ----------

const fake = (() => {
  const g = globalThis as unknown as { __leashFake?: { batches: Set<string>; orders: Map<string, string> } };
  const s = (g.__leashFake ??= { batches: new Set(), orders: new Map() });
  return {
    orders: s.orders,
    payout(p: { batchId: string }): Payout {
      if (s.batches.has(p.batchId)) {
        throw new PayPalError(422, "DUPLICATE_REQUEST_ID", "sender_batch_id was already used");
      }
      s.batches.add(p.batchId);
      return { batchId: p.batchId, payoutBatchId: `FAKE-${randomUUID().slice(0, 8)}`, status: "PENDING" };
    },
    order(p: { requestId: string }): Order {
      const orderId = `FAKE-ORDER-${randomUUID().slice(0, 8)}`;
      s.orders.set(orderId, "PAYER_ACTION_REQUIRED");
      return {
        orderId,
        status: "PAYER_ACTION_REQUIRED",
        approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}&ref=${p.requestId}`,
      };
    },
  };
})();
