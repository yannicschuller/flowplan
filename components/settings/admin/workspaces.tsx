"use client";
// Administration → Arbeitsbereiche: every workspace with its usage and quota.
import { useState } from "react";
import { useT } from "../../i18n";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { mb } from "./format";

export default function WorkspacesSection() {
  const t = useT();
  const { data, act } = useAdminData();
  const [query, setQuery] = useState("");
  if (!data) return <AdminLoading />;
  return (
    <section className="settings-section">
      <div className="settings-list-head">
        <h2>{t("Arbeitsbereiche ·", "Workspaces ·")}{" "}{data.workspaces.length}</h2>
        <input type="search" aria-label={t("Arbeitsbereiche suchen", "Search workspaces")} placeholder={t("Arbeitsbereich suchen …", "Search workspace …")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="data-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("Arbeitsbereich", "Workspace")}</th>
              <th>{t("Mitglieder", "Members")}</th>
              <th>{t("Seiten", "Pages")}</th>
              <th>{t("Speicher", "Storage")}</th>
              <th>{t("Kontingent (MB)", "Quota (MB)")}</th>
            </tr>
          </thead>
          <tbody>
            {data.workspaces
              .filter((w) => w.name.toLowerCase().includes(query.toLowerCase()))
              .map((w) => {
                const usage = data.usage.find((u) => u.id === w.id);
                const quota = usage?.effectiveQuotaMb || 0;
                return (
                  <tr key={w.id}>
                    <td>{w.name}</td>
                    <td>{w.members}</td>
                    <td>{w.pages}</td>
                    <td>
                      {mb(usage?.bytes || 0)}
                      {quota > 0 && <meter min={0} max={quota * 1024 * 1024} value={usage?.bytes || 0} high={quota * 1024 * 1024 * 0.9} aria-label={t(`Belegung ${w.name}`, `Usage ${w.name}`)} />}
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        className="quota-input"
                        aria-label={t(`Kontingent ${w.name}`, `Quota ${w.name}`)}
                        placeholder={data.metrics.defaultQuotaMb ? t(`Standard ${data.metrics.defaultQuotaMb}`, `Default ${data.metrics.defaultQuotaMb}`) : t("unbegrenzt", "unlimited")}
                        defaultValue={usage?.quotaMb ?? ""}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const next = raw === "" ? null : Number(raw);
                          if (next === (usage?.quotaMb ?? null)) return;
                          void act({ action: "admin.quota", workspaceId: w.id, quotaMb: next });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
