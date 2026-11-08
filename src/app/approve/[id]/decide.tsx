"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function Decide({ id, approveUrl }: { id: string; approveUrl?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const reject = async () => {
    setBusy(true);
    await fetch("/api/approve", { method: "POST", body: JSON.stringify({ id, action: "reject" }) }).catch(() => null);
    router.refresh();
  };
  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-center gap-4">
        {approveUrl && (
          <a
            href={approveUrl}
            className="inline-flex h-12 items-center bg-ink px-6 text-[15px] font-medium text-paper transition-colors hover:bg-ink-hover"
          >
            review and approve in paypal
          </a>
        )}
        <button
          onClick={reject}
          disabled={busy}
          className="h-12 border border-line px-6 text-[15px] text-slate transition-colors hover:text-ink disabled:opacity-50"
        >
          reject
        </button>
      </div>
      <p className="mt-4 max-w-[560px] text-[13px] leading-relaxed text-mute">
        approving happens on paypal.com, logged in as the owner. leash only sees paypal&apos;s answer and captures the
        payment after you approve. in this sandbox demo the owner is a paypal sandbox account.
      </p>
    </div>
  );
}
