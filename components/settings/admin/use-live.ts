"use client";
// Live data for the monitoring: loads the address now and every `every` ms
// while the page is visible; pauses when the tab is hidden and loads again
// as soon as it shows. `state` drives the "Live" indicator.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../ui";

export type LiveState = "loading" | "live" | "paused" | "error";

export function useLive<T>(url: string, every = 15_000) {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<LiveState>("loading");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const busy = useRef(false);
  const current = useRef(url);
  current.current = url;
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const asked = current.current;
    try {
      const answer = await api<T>(asked);
      // A newer address (another range) was asked meanwhile: drop this one.
      if (asked !== current.current) return;
      setData(answer);
      setError("");
      setUpdatedAt(Date.now());
      setState(document.visibilityState === "visible" ? "live" : "paused");
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [url, load]);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => void load(), every);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        clearInterval(timer);
        setState((s) => (s === "live" ? "paused" : s));
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [every, load]);
  return { data, setData, state, error, updatedAt, reload: load };
}
