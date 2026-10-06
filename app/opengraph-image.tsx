import { ImageResponse } from "next/og";

// The preview image for links to the app (sign-in, templates).
export const alt = "Flowplan – open-source workspace";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4146e6"/><stop offset="1" stop-color="#6a3fe0"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M16 6.8 25.2 11.4 16 16 6.8 11.4Z" fill="#fff"/><g fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.8 16 16 20.6 25.2 16" opacity=".72"/><path d="M6.8 20.6 16 25.2 25.2 20.6" opacity=".42"/></g></svg>`;

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 80, background: "#fcfbf8", color: "#1d1c22" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`} width={84} height={84} alt="" />
          <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>flowplan</span>
          
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>Everything you work on.</div>
          <div style={{ fontSize: 34, color: "#5e5a66", lineHeight: 1.3 }}>
            Documents, databases, whiteboards and a journal. Open source – hosted in Germany or on your own server.
          </div>
        </div>
        <div style={{ display: "flex", height: 10, width: 180, background: "#3b3fd8", borderRadius: 5 }} />
      </div>
    ),
    size,
  );
}
