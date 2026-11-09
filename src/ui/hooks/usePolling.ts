import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refresh(): void;
}

/** Calls `fn` now and every `intervalMs`; errors are captured, never thrown. */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  const inflight = useRef(false);

  const run = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const value = await fnRef.current();
      if (alive.current) {
        setData(value);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      inflight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void run();
    const timer = intervalMs > 0 ? setInterval(() => void run(), intervalMs) : null;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [run, intervalMs, ...deps]);

  return {
    data,
    error,
    loading,
    refresh: () => {
      setLoading(true);
      void run();
    },
  };
}
