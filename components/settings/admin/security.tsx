"use client";
// Administration → Verschlüsselung: the key for bucket, backups and exports.
import { EncryptionSettings } from "../../encryption-settings";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";

export default function SecuritySection() {
  const { data, load, onError } = useAdminData();
  if (!data) return <AdminLoading />;
  return <EncryptionSettings status={data.encryption} onChange={load} onError={onError} />;
}
