"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function Decide({ id, approveUrl }: { id: string; approveUrl?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const reject = async () => {
    setBusy(true);
    const r = await fetch("/api/approve", { method: "POST", body: JSON.stringify({ id, action: "reject", key }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setNote(r?.status === 401 ? "wrong owner key. nothing changed." : "that didn't go through. try again.");
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
          disabled={busy || !key}
          className="h-12 border border-line px-6 text-[15px] text-slate transition-colors hover:text-ink disabled:opacity-50"
        >
          reject
        </button>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="owner key, to reject"
          autoComplete="off"
          className="h-12 w-[220px] border border-line bg-transparent px-4 text-[15px] outline-none"
        />
      </div>
      {note && <p className="mt-3 text-[13px] text-slate">{note}</p>}
      <p className="mt-4 max-w-[560px] text-[13px] leading-relaxed text-mute">
        approving happens on paypal.com, logged in as the owner. leash only sees paypal&apos;s answer and captures the
        payment after you approve. in this sandbox demo the owner is a paypal sandbox account.
      </p>
    </div>
  );
}
