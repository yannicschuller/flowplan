"use client";
// Administration → Markdown- & Git-Export: chosen pages as Markdown with
// every backup, optionally pushed to a Git repository.
import { MarkdownExportSettings } from "../../markdown-export-settings";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";

export default function ExportSection() {
  const { data, load, onError } = useAdminData();
  if (!data) return <AdminLoading />;
  return <MarkdownExportSettings status={data.markdownExport} spaceGit={data.spaceGitExport} onChange={load} onError={onError} />;
}
