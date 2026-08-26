import { useEffect, useRef } from "react";

export function ErrorSummary({ message }: { message?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.focus(); }, [message]);
  return message ? <div className="error-summary" role="alert" tabIndex={-1} ref={ref}><strong>There is a problem</strong><p>{message}</p></div> : null;
}
export function StateNotice({ title, children }: { title: string; children: React.ReactNode }) { return <section className="state-notice" aria-labelledby="state-title"><h2 id="state-title">{title}</h2>{children}</section>; }
