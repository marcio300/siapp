"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pending: pendingLabel }: { children: React.ReactNode; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn-primary w-full !py-3 text-base" aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
