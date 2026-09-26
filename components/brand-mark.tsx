import { useId } from "react";

// Flowplan's mark: a solid plan on top, two layers flowing out beneath it,
// on an ultramarine tile. Keep in sync with public/icon.svg.
export function BrandMark({ size = 32 }: { size?: number }) {
  const id = useId();
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4146e6" />
          <stop offset="1" stopColor="#6a3fe0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M16 6.8 25.2 11.4 16 16 6.8 11.4Z" fill="#fff" />
      <g fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.8 16 16 20.6 25.2 16" opacity=".72" />
        <path d="M6.8 20.6 16 25.2 25.2 20.6" opacity=".42" />
      </g>
    </svg>
  );
}
