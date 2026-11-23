"use client";
// The QR code of a page or a record (#448), from the page's "⋯" menu and a
// record's menus: the same dialog as a form's (components/form-qr.tsx) with
// the address "Copy link" gives (lib/qr-labels.ts). Loaded on first use.
import { useT } from "./i18n";
import { QrDialog } from "./form-qr";
import { itemLink } from "@/lib/qr-labels";

export default function ItemQrDialog({ pageId, rowId, title, onClose }: { pageId: string; rowId?: string; title: string; onClose: () => void }) {
  const t = useT();
  const record = !!rowId;
  const url = itemLink(`${location.origin}${location.pathname}`, { pageId, rowId });
  return (
    <QrDialog
      open
      onClose={onClose}
      url={url}
      title={title}
      heading={record ? t("QR-Code des Eintrags", "Record QR code") : t("QR-Code der Seite", "Page QR code")}
      codeLabel={record ? t("QR-Code mit dem Link zum Eintrag", "QR code with the link to the record") : t("QR-Code mit dem Link zur Seite", "QR code with the link to the page")}
      fallbackName={record ? "record" : "page"}
      note={
        record
          ? t(
              "Gescannt öffnet der Code diesen Eintrag für alle, die angemeldet sind und ihn sehen dürfen – zum Beispiel als Etikett auf einer Kiste.",
              "Scanned, the code opens this record for everyone who is signed in and may see it – for example as a label on a box.",
            )
          : t(
              "Gescannt öffnet der Code diese Seite für alle, die angemeldet sind und sie sehen dürfen – zum Beispiel als Etikett auf einer Kiste.",
              "Scanned, the code opens this page for everyone who is signed in and may see it – for example as a label on a box.",
            )
      }
    />
  );
}
