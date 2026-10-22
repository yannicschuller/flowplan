"use client";
// Administration → Aktivitätsprotokoll: the latest changes and the export.
import { useState } from "react";
import { useT } from "../../i18n";
import { AuditExport } from "../../admin-operations";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { auditTime } from "./format";

export default function AuditSection() {
  const t = useT();
  const { data } = useAdminData();
  const [query, setQuery] = useState("");
  if (!data) return <AdminLoading />;
  return (
    <section className="settings-section">
      <div className="settings-list-head">
        <h2>{t("Aktivitätsprotokoll", "Activity log")}</h2>
        <AuditExport />
        <input type="search" aria-label={t("Protokoll durchsuchen", "Search the log")} placeholder={t("Person oder Aktion suchen …", "Search person or action …")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="data-table-scroll">
        <table className="data-table audit-table">
          <thead>
            <tr>
              <th>{t("Zeitpunkt", "Time")}</th>
              <th>{t("Person", "Person")}</th>
              <th>{t("Aktion", "Action")}</th>
              <th>{t("Ressource", "Resource")}</th>
            </tr>
          </thead>
          <tbody>
            {data.audit
              .filter((a) => `${a.name || "System"} ${a.action}`.toLowerCase().includes(query.toLowerCase()))
              .map((a) => (
                <tr key={a.id}>
                  <td>{auditTime(a.created_at)}</td>
                  <td>{a.name || t("System", "System")}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>
                    <small>{a.resource_id.slice(0, 8)}</small>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
