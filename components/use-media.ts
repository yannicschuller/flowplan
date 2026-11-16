"use client";
import { useEffect, useState } from "react";

// Whether a media query matches, kept up to date. Its own module so the
// workspace does not load the Ask panel (components/ai-ask.tsx) for it.
export function useMedia(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
