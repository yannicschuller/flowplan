"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadSimple, Printer } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { printPage } from "./print-page";
import { QR_QUIET_ZONE, qrModules, qrPath, qrSvg } from "@/lib/qr";

// The QR code of a form's link (#415): shown dark on a white tile (so it
// scans in dark mode too), downloaded as SVG or as a PNG large enough to
// print, and printed as a sheet with the form's title and the link.
const PNG_SIDE = 1024;

// A file name from the form's title ("Einkaufsliste-qr.svg").
export function qrFileName(title: string, extension: "svg" | "png") {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "form"}-qr.${extension}`;
}

// The PNG: the SVG drawn on a canvas at whole pixels per module, at least
// PNG_SIDE pixels wide; module by module if the browser cannot draw the SVG.
async function pngBlob(modules: boolean[][], svg: string) {
  const total = modules.length + 2 * QR_QUIET_ZONE,
    scale = Math.ceil(PNG_SIDE / total),
    side = total * scale;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    context.drawImage(image, 0, 0, side, side);
  } catch {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, side, side);
    context.fillStyle = "#000";
    modules.forEach((row, y) =>
      row.forEach((dark, x) => dark && context.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale)),
    );
  } finally {
    URL.revokeObjectURL(source);
  }
  return new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
}

export function FormQrDialog({ open, onClose, url, title }: { open: boolean; onClose: () => void; url: string; title: string }) {
  const t = useT();
  const sheet = useRef<HTMLDivElement>(null);
  const modules = useMemo(() => {
    if (!open) return null;
    try {
      return qrModules(url);
    } catch {
      return null;
    }
  }, [open, url]);
  const [svgUrl, setSvgUrl] = useState(""),
    [pngUrl, setPngUrl] = useState("");
  useEffect(() => {
    if (!modules) return;
    const svg = qrSvg(modules);
    const svgLink = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    let pngLink = "",
      gone = false;
    setSvgUrl(svgLink);
    void pngBlob(modules, svg)
      .then((blob) => {
        if (!blob || gone) return;
        pngLink = URL.createObjectURL(blob);
        setPngUrl(pngLink);
      })
      .catch(() => {});
    return () => {
      gone = true;
      URL.revokeObjectURL(svgLink);
      if (pngLink) URL.revokeObjectURL(pngLink);
      setSvgUrl("");
      setPngUrl("");
    };
  }, [modules]);
  const side = modules ? modules.length + 2 * QR_QUIET_ZONE : 0;
  return (
    <Modal open={open} onClose={onClose} title={t("QR-Code des Formulars", "Form QR code")} className="form-qr-dialog">
      {modules ? (
        <>
          <div className="form-qr-sheet" ref={sheet}>
            <h3 className="form-qr-title">{title}</h3>
            <svg
              className="form-qr-code"
              role="img"
              aria-label={t("QR-Code mit dem Formularlink", "QR code with the form link")}
              viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${side} ${side}`}
              shapeRendering="crispEdges"
            >
              <rect x={-QR_QUIET_ZONE} y={-QR_QUIET_ZONE} width={side} height={side} fill="#fff" />
              <path d={qrPath(modules)} fill="#000" />
            </svg>
            <p className="form-qr-link">{url}</p>
          </div>
          <div className="modal-actions form-qr-actions">
            {svgUrl && (
              <a className="button" href={svgUrl} download={qrFileName(title, "svg")} type="image/svg+xml">
                <DownloadSimple aria-hidden /> {t("SVG herunterladen", "Download SVG")}
              </a>
            )}
            {pngUrl && (
              <a className="button" href={pngUrl} download={qrFileName(title, "png")} type="image/png">
                <DownloadSimple aria-hidden /> {t("PNG herunterladen", "Download PNG")}
              </a>
            )}
            <button type="button" className="button primary" onClick={() => sheet.current && printPage(sheet.current)}>
              <Printer aria-hidden /> {t("Drucken", "Print")}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">{t("Zu viel Text für den QR-Code.", "Too much text for the QR code.")}</p>
      )}
    </Modal>
  );
}
