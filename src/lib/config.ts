import "server-only";

// Vendors the owner pre-approved, identified by their paypal email.
// Override with LEASH_VENDORS='[{"name":"...","email":"..."}]' (sandbox personal accounts).
const DEFAULT_VENDORS = [
  { name: "northwind hosting", email: "northwind@leash-demo.example" },
  { name: "paperplane design studio", email: "paperplane@leash-demo.example" },
  { name: "bean & bolt coffee", email: "beanandbolt@leash-demo.example" },
];

export const VENDORS: { name: string; email: string }[] = process.env.LEASH_VENDORS
  ? JSON.parse(process.env.LEASH_VENDORS)
  : DEFAULT_VENDORS;

/** Hard limits, enforced by the policy gate on our server before any paypal call. */
export const MAX_PER_PAYMENT_USD = Number(process.env.LEASH_MAX_PER_PAYMENT_USD ?? 20);
export const DAILY_CAP_USD = Number(process.env.LEASH_DAILY_CAP_USD ?? 50);

/** Largest amount the agent may even ask the owner about. */
export const MAX_APPROVAL_USD = Number(process.env.LEASH_MAX_APPROVAL_USD ?? 500);

export const APP_URL = process.env.LEASH_APP_URL ?? "http://localhost:3000";

export const isVendor = (email: string) =>
  VENDORS.some((v) => v.email.toLowerCase() === email.trim().toLowerCase());
