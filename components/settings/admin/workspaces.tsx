"use client";
// Administration → Arbeitsbereiche: every workspace with its owners, members,
// pages, storage used and its own quota (saved when the field is left). A
// table on wide screens, a list on phones; PAGE_SIZE rows at a time.
import { useState } from "react";
import { CaretLeft, CaretRight, MagnifyingGlass, Stack } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { EmptyState, ResponsiveTable, SaveState, useSaveState } from "../../settings-ui";
import { useAdminData, type AdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, NumberInput } from "./parts";
import { mb } from "./format";

// From this share of its quota a workspace counts as nearly full (as the
// tile and the storage alert).
const NEARLY_FULL = 0.9;
const PAGE_SIZE = 25;
type Row = AdminData["workspaces"][number] & {
  bytes: number;
  quotaMb: number | null;
  effective: number;
  share: number;
};

export default function WorkspacesSection() {
  const t = useT();
  const { data } = useAdminData();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  if (!data) return <AdminLoading />;
  const rows: Row[] = data.workspaces.map((w) => {
    const usage = data.usage.find((u) => u.id === w.id);
    const effective = usage?.effectiveQuotaMb || 0;
    const bytes = usage?.bytes || 0;
    return {
      ...w,
      bytes,
      quotaMb: usage?.quotaMb ?? null,
      effective,
      share: effective ? bytes / (effective * 1024 * 1024) : 0,
    };
  });
  const full = rows.filter((r) => r.share >= NEARLY_FULL).length;
  const needle = query.trim().toLocaleLowerCase();
  // By name or by an owner's name or address.
  const found = rows.filter(
    (w) =>
      !needle ||
      w.name.toLocaleLowerCase().includes(needle) ||
      w.owners.some((o) => o.name.toLocaleLowerCase().includes(needle) || (o.email || "").toLocaleLowerCase().includes(needle)),
  );
  const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = found.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const quota = data.metrics.defaultQuotaMb;
  return (
    <>
      <AdminStatus
        items={[
          {
            tone: "ok",
            label: rows.length === 1 ? t("1 Arbeitsbereich", "1 workspace") : t(`${rows.length} Arbeitsbereiche`, `${rows.length} workspaces`),
          },
          full
            ? {
                tone: "warn",
                label: t(`${full} fast voll`, `${full} nearly full`),
              }
            : {
                tone: "ok",
                label: t("Kein Kontingent knapp", "No quota running low"),
              },
          {
            tone: quota ? "info" : "off",
            label: quota ? t(`Standard ${quota} MB`, `Default ${quota} MB`) : t("Standard unbegrenzt", "Default unlimited"),
          },
        ]}
        action={<FixLink href="#admin/limits/storage-limits">{t("Standard ändern", "Change default")}</FixLink>}
      >
        {t("Ein eigenes Kontingent gilt statt des Standards; leer = Standard, 0 = unbegrenzt.", "An own quota applies instead of the default; empty = default, 0 = unlimited.")}
      </AdminStatus>
      <section className="admin-list-card" aria-labelledby="admin-workspaces-title">
        <header className="admin-users-head">
          <h2 id="admin-workspaces-title">
            {t("Arbeitsbereiche", "Workspaces")} <span className="muted">· {rows.length}</span>
          </h2>
          <span className="admin-search">
            <MagnifyingGlass size={16} aria-hidden />
            <input
              type="search"
              aria-label={t("Arbeitsbereiche suchen", "Search workspaces")}
              placeholder={t("Arbeitsbereich oder Besitzer suchen …", "Search workspace or owner …")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </span>
        </header>
        <ResponsiveTable
          label={t("Arbeitsbereiche", "Workspaces")}
          rows={shown}
          rowKey={(w) => w.id}
          empty={<EmptyState icon={<Stack size={18} />} title={t("Kein Arbeitsbereich gefunden", "No workspace found")} />}
          columns={[
            {
              key: "name",
              header: t("Arbeitsbereich", "Workspace"),
              primary: true,
              render: (w) => w.name,
            },
            {
              key: "owners",
              header: t("Besitzer", "Owner"),
              render: (w) =>
                w.owners.length ? (
                  <span className="admin-owners">
                    {w.owners.map((o) => (
                      <span key={o.id} className="admin-owner" title={o.email ? `${o.name} · ${o.email}` : o.name}>
                        <span>{o.name}</span>
                        {o.email && <span className="muted">{o.email}</span>}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="muted">{t("Kein Besitzer", "No owner")}</span>
                ),
            },
            {
              key: "members",
              header: t("Mitglieder", "Members"),
              align: "end",
              render: (w) => w.members,
            },
            {
              key: "pages",
              header: t("Seiten", "Pages"),
              align: "end",
              render: (w) =>
                w.days ? (
                  <span title={t(`${w.pages} Seiten · ${w.days} Journaltage`, `${w.pages} pages · ${w.days} journal days`)}>
                    {w.pages}
                    <small className="muted admin-day-count">{t(`${w.days} Journaltage`, `${w.days} journal days`)}</small>
                  </span>
                ) : (
                  w.pages
                ),
            },
            {
              key: "usage",
              header: t("Belegung", "Usage"),
              render: (w) => (
                <span className={`admin-usage${w.share >= NEARLY_FULL ? " full" : ""}`}>
                  <span>
                    {mb(w.bytes)}
                    {w.effective ? ` / ${w.effective} MB` : ""}
                  </span>
                  {w.effective > 0 && (
                    <span
                      className="admin-usage-bar"
                      role="meter"
                      aria-label={t(`Belegung ${w.name}`, `Usage ${w.name}`)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(Math.min(1, w.share) * 100)}
                    >
                      <span
                        style={{
                          width: `${Math.max(2, Math.min(1, w.share) * 100)}%`,
                        }}
                      />
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "quota",
              header: t("Eigenes Kontingent", "Own quota"),
              align: "end",
              render: (w) => <Quota row={w} fallback={quota} />,
            },
          ]}
        />
        {pages > 1 && (
          <nav className="admin-pager" aria-label={t("Seiten der Arbeitsbereiche", "Workspace pages")}>
            <span className="muted">
              {t(
                `${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + shown.length} von ${found.length}`,
                `${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + shown.length} of ${found.length}`,
              )}
            </span>
            <button type="button" className="button" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={t("Vorherige Seite", "Previous page")}>
              <CaretLeft size={14} aria-hidden />
            </button>
            <span className="admin-pager-page">{t(`Seite ${current + 1} von ${pages}`, `Page ${current + 1} of ${pages}`)}</span>
            <button type="button" className="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label={t("Nächste Seite", "Next page")}>
              <CaretRight size={14} aria-hidden />
            </button>
          </nav>
        )}
      </section>
    </>
  );
}

function Quota({ row, fallback }: { row: Row; fallback: number }) {
  const t = useT();
  const { mutate, load } = useAdminData();
  const [status, run] = useSaveState();
  return (
    <span className="admin-quota">
      <SaveState status={status} />
      <NumberInput
        label={t(`Kontingent ${row.name}`, `Quota ${row.name}`)}
        value={row.quotaMb}
        unit="MB"
        placeholder={fallback ? t(`Standard ${fallback}`, `Default ${fallback}`) : t("unbegrenzt", "unlimited")}
        onCommit={(quotaMb) =>
          void run(async () => {
            await mutate({
              action: "admin.quota",
              workspaceId: row.id,
              quotaMb,
            });
            await load();
          })
        }
      />
    </span>
  );
}
