import { useEffect, useRef, useState } from "react";

export type Route = "assistant" | "desk" | "expenses" | "policy";
const ROUTES: Route[] = ["assistant", "desk", "expenses", "policy"];

function currentRoute(): Route {
  const name = window.location.hash.replace(/^#\/?/, "");
  return ROUTES.includes(name as Route) ? (name as Route) : "assistant";
}

/** Three destinations do not need a router library: the hash is the route. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Seconds since `startedAt`, updated once a second. Real time, not a fake progress. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Animates a number from the value it had to the value it has now. The target
 * is always a real figure from the backend; only the way it arrives is animated.
 */
export function useCountUp(target: number, durationMs = 700): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);

  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    if (prefersReducedMotion()) {
      from.current = target;
      setShown(target);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, (time - began) / durationMs);
      const eased = 1 - (1 - progress) ** 4;
      const value = Math.round(start + (target - start) * eased);
      setShown(value);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else from.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      from.current = target;
    };
  }, [target, durationMs]);

  return shown;
}

/** True when the viewport is at least `minRem` wide (default: the two-pane layout's breakpoint). */
export function useIsWide(minRem = 48): boolean {
  const query = `(min-width: ${minRem}rem)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return wide;
}
