"use client";
// Administration → Anmeldung & SSO: SSO groups mapped centrally, user
// provisioning over SCIM and the LDAP directory.
import { useT } from "../../i18n";
import { SsoMappings } from "../../sso-mappings";
import { AdminDirectory } from "../../admin-directory";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";

export default function SigninSection() {
  const t = useT();
  const { data, act, onError } = useAdminData();
  if (!data) return <AdminLoading />;
  return (
    <>
      {(data.oidcConfigured || !!data.ssoMappings?.length) && (
        <section className="settings-section">
          <h2>{t("SSO-Gruppen zentral zuordnen", "Map SSO groups centrally")}</h2>
          <p className="muted">
            {t(
              "Gruppen aus dem Identitätsanbieter geben bei jeder SSO-Anmeldung eine Rolle im gewählten Arbeitsbereich und/oder eine seiner Gruppen. Dieselben Zuordnungen sehen und pflegen die Eigentümer des Arbeitsbereichs in seinen Einstellungen.",
              "Groups from the identity provider give a role in the chosen workspace and/or one of its groups at every SSO sign-in. The workspace's owners see and maintain the same mappings in its settings.",
            )}
          </p>
          <SsoMappings
            mappings={data.ssoMappings || []}
            groups={data.workspaceGroups || []}
            workspaces={data.workspaces}
            onAdd={async (workspaceId, m) => !!(await act({ action: "admin.ssoMapping.add", workspaceId, ...m }))}
            onDelete={(workspaceId, id) => act({ action: "admin.ssoMapping.delete", workspaceId, id })}
          />
        </section>
      )}
      <AdminDirectory onError={onError} />
    </>
  );
}
