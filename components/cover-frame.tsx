"use client";
// A cover (page, record): a colour or an image filling the box; uploaded
// images show their blurred placeholder until they have faded in
// (components/image-placeholder.ts).
import type { ReactNode } from "react";
import { useImagePlaceholder } from "./image-placeholder";

export function CoverFrame({
  className,
  cover,
  image,
  alt = "",
  position,
  children,
}: {
  className: string;
  /** A colour ("#rrggbb") or an image URL. */
  cover: string;
  /** Whether `cover` is an image to show. */
  image: boolean;
  alt?: string;
  /** object-position of the image. */
  position?: string;
  children?: ReactNode;
}) {
  const placeholder = useImagePlaceholder(image ? cover : null, { position });
  return (
    <div className={className} style={cover.startsWith("#") ? { background: cover } : placeholder.frameStyle}>
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover} alt={alt} style={position ? { objectPosition: position } : undefined} {...placeholder.imgProps} />
      )}
      {children}
    </div>
  );
}
