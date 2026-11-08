import "server-only";
import { Redis } from "@upstash/redis";

export type Outcome = "agent_refused" | "policy_refused" | "escalated" | "paid_vendor" | "error";

export type Step =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown; output?: unknown };

export type Attempt = {
  id: string;
  createdAt: number;
  invoice: string;
  preset?: string;
  steps: Step[];
  outcome: Outcome;
  /** paypal references: payout batch ids, order ids, approve links */
  txs: { label: string; explorer?: string; ref?: string; error?: string }[];
};

// every key is prefixed so this app can share a redis with other apps without collisions.
const P = process.env.LEASH_KEY_PREFIX ?? "";

// Upstash when configured (deployed), process memory otherwise (local dev).
const redis =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
    ? new Redis({
        url: (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL)!,
        token: (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)!,
      })
    : null;

type Mem = {
  attempts: Map<string, Attempt>;
  feed: string[];
  counts: Record<string, number>;
  hits: Map<string, number>;
  kv: Map<string, unknown>;
};
const g = globalThis as unknown as { __leash?: Mem };
const mem: Mem = (g.__leash ??= { attempts: new Map(), feed: [], counts: {}, hits: new Map(), kv: new Map() });
mem.kv ??= new Map();

export async function saveAttempt(a: Attempt) {
  if (redis) {
    await Promise.all([
      redis.set(`${P}attempt:${a.id}`, a),
      redis.lpush(P + "feed", a.id).then(() => redis.ltrim(P + "feed", 0, 499)),
      redis.incr(`${P}count:${a.outcome}`),
    ]);
    return;
  }
  mem.attempts.set(a.id, a);
  mem.feed.unshift(a.id);
  mem.feed.length = Math.min(mem.feed.length, 500);
  mem.counts[a.outcome] = (mem.counts[a.outcome] ?? 0) + 1;
}

export async function getAttempt(id: string): Promise<Attempt | null> {
  if (redis) return redis.get<Attempt>(`${P}attempt:${id}`);
  return mem.attempts.get(id) ?? null;
}

export async function feed(limit = 20): Promise<Attempt[]> {
  const ids = redis ? await redis.lrange<string>(P + "feed", 0, limit - 1) : mem.feed.slice(0, limit);
  const all = await Promise.all(ids.map(getAttempt));
  return all.filter((a): a is Attempt => !!a);
}

export async function counts(): Promise<Record<Outcome, number>> {
  const keys: Outcome[] = ["agent_refused", "policy_refused", "escalated", "paid_vendor", "error"];
  if (redis) {
    const vals = await redis.mget<(number | null)[]>(...keys.map((k) => `${P}count:${k}`));
    return Object.fromEntries(keys.map((k, i) => [k, Number(vals[i] ?? 0)])) as Record<Outcome, number>;
  }
  return Object.fromEntries(keys.map((k) => [k, mem.counts[k] ?? 0])) as Record<Outcome, number>;
}

/** Fixed-window counter. Returns true while under the limit. */
export async function allow(key: string, limit: number, windowSec: number): Promise<boolean> {
  const bucket = `${P}rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  if (redis) {
    const n = await redis.incr(bucket);
    if (n === 1) await redis.expire(bucket, windowSec);
    return n <= limit;
  }
  const n = (mem.hits.get(bucket) ?? 0) + 1;
  mem.hits.set(bucket, n);
  return n <= limit;
}

// ---------- policy state ----------

const day = () => new Date().toISOString().slice(0, 10); // UTC day
const spendKey = () => `${P}spend:${day()}`;

/**
 * Atomically reserve `cents` of today's budget. Returns the new total, or null if it
 * would cross `capCents`. One Lua script in Redis, so parallel agents can't race past the cap.
 */
export async function reserveSpend(cents: number, capCents: number): Promise<number | null> {
  if (redis) {
    const r = await redis.eval<[number, number], number>(
      `local n = redis.call('INCRBY', KEYS[1], ARGV[1])
       if n == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], 172800) end
       if n > tonumber(ARGV[2]) then redis.call('DECRBY', KEYS[1], ARGV[1]) return -1 end
       return n`,
      [spendKey()],
      [cents, capCents],
    );
    return r < 0 ? null : r;
  }
  const n = ((mem.kv.get(spendKey()) as number) ?? 0) + cents;
  if (n > capCents) return null;
  mem.kv.set(spendKey(), n);
  return n;
}

export async function releaseSpend(cents: number) {
  if (redis) return void (await redis.decrby(spendKey(), cents));
  mem.kv.set(spendKey(), ((mem.kv.get(spendKey()) as number) ?? 0) - cents);
}

export async function spentTodayCents(): Promise<number> {
  if (redis) return Number((await redis.get<number>(spendKey())) ?? 0);
  return (mem.kv.get(spendKey()) as number) ?? 0;
}

/** First caller wins. Returns true if this caller claimed `key`. */
export async function claimOnce(key: string, ttlSec = 86400 * 30): Promise<boolean> {
  if (redis) return (await redis.set(`${P}once:${key}`, Date.now(), { nx: true, ex: ttlSec })) === "OK";
  if (mem.kv.has(`${P}once:${key}`)) return false;
  mem.kv.set(`${P}once:${key}`, Date.now());
  return true;
}

export async function putRecord<T>(key: string, v: T) {
  if (redis) return void (await redis.set(P + key, v));
  mem.kv.set(key, v);
}

export async function getRecord<T>(key: string): Promise<T | null> {
  if (redis) return redis.get<T>(P + key);
  return (mem.kv.get(key) as T) ?? null;
}

export type Approval = {
  id: string;
  attemptId: string;
  to: string;
  amountUsd: number;
  reason: string;
  createdAt: number;
  status: "waiting_for_owner" | "paid" | "rejected" | "failed";
  orderId?: string;
  approveUrl?: string;
  captureId?: string;
  error?: string;
};

export async function saveApproval(a: Approval) {
  await putRecord(`approval:${a.id}`, a);
  if (redis) await redis.lpush(P + "approvals", a.id).then(() => redis.ltrim(P + "approvals", 0, 199));
  else mem.kv.set(P + "approvals", [a.id, ...((mem.kv.get(P + "approvals") as string[]) ?? [])]);
}

export async function updateApproval(id: string, patch: Partial<Approval>) {
  const a = await getRecord<Approval>(`approval:${id}`);
  if (!a) return null;
  const next = { ...a, ...patch };
  await putRecord(`approval:${id}`, next);
  return next;
}

export async function listApprovals(limit = 20): Promise<Approval[]> {
  const ids = redis
    ? await redis.lrange<string>(P + "approvals", 0, limit - 1)
    : ((mem.kv.get(P + "approvals") as string[]) ?? []).slice(0, limit);
  const all = await Promise.all([...new Set(ids)].map((id) => getRecord<Approval>(`approval:${id}`)));
  return all.filter((a): a is Approval => !!a);
}
