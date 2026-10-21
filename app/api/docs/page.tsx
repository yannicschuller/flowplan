import type { ReactNode } from "react";
import { serverT } from "@/lib/i18n-server";
import { openApiDocument } from "@/lib/openapi";

export const dynamic = "force-dynamic";

// Human-readable view of the OpenAPI document (lib/openapi.ts): every path
// with its parameters, bodies and answers, then the schemas. Rendered on
// the server without scripts, so it works everywhere the JSON does.
type Json = Record<string, unknown>;
type Schemas = Record<string, Json>;

export async function generateMetadata() {
  const t = await serverT();
  return {
    title: t("API-Dokumentation · Flowplan", "API documentation · Flowplan"),
    description: t("Die HTTP-API dieser Flowplan-Instanz: Endpunkte, Parameter und Antworten.", "The HTTP API of this Flowplan instance: endpoints, parameters and answers."),
    robots: { index: false, follow: false },
  };
}

// `code` spans in descriptions become <code>; paragraphs split at blank lines.
function Text({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\n+/).map((paragraph, i) => (
        <p key={i}>
          {paragraph.split(/(`[^`]+`)/).map((part, j) =>
            part.startsWith("`") && part.endsWith("`") ? <code key={j}>{part.slice(1, -1)}</code> : <span key={j}>{part}</span>,
          )}
        </p>
      ))}
    </>
  );
}

const refName = (schema: Json) => String(schema.$ref).split("/").pop() || "";
// A one-line type, as in a signature.
function typeText(schema: Json | undefined): string {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema);
  const variants = (schema.oneOf || schema.anyOf) as Json[] | undefined;
  if (variants) return variants.map(typeText).join(" | ");
  if (schema.allOf) return (schema.allOf as Json[]).map(typeText).join(" & ");
  if (schema.enum) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [String(schema.type)] : schema.properties ? ["object"] : [];
  if (!types.length) return "any";
  return types
    .map((type) => {
      if (type === "array") {
        const item = typeText(schema.items as Json | undefined);
        return `${/[|&]/.test(item) ? `(${item})` : item}[]`;
      }
      if (type === "string" && schema.format) return `string (${String(schema.format)})`;
      return type;
    })
    .join(" | ");
}
const properties = (schema: Json | undefined) => (schema?.properties ? Object.entries(schema.properties as Schemas) : []);

// Properties of an object, nested two levels deep; references stay links.
function SchemaView({ schema, schemas, depth = 0 }: { schema: Json | undefined; schemas: Schemas; depth?: number }) {
  if (!schema) return null;
  if (schema.$ref) return <SchemaLink name={refName(schema)} />;
  const variants = (schema.oneOf || schema.anyOf) as Json[] | undefined;
  if (variants)
    return (
      <ul className="api-variants">
        {variants.map((v, i) => (
          <li key={i}>
            <SchemaView schema={v} schemas={schemas} depth={depth} />
          </li>
        ))}
      </ul>
    );
  if (schema.type === "array" && schema.items) {
    const items = schema.items as Json;
    return (
      <span>
        {typeText(schema)}
        {!items.$ref && properties(items).length > 0 && <SchemaView schema={items} schemas={schemas} depth={depth} />}
      </span>
    );
  }
  const props = properties(schema);
  if (!props.length) return <span className="api-type">{typeText(schema)}</span>;
  const required = new Set((schema.required as string[]) || []);
  return (
    <ul className="api-props">
      {props.map(([name, prop]) => (
        <li key={name}>
          <code>{name}</code>
          {required.has(name) && <span className="api-required">*</span>} <span className="api-type">{prop.$ref ? <SchemaLink name={refName(prop)} /> : typeText(prop)}</span>
          {prop.description ? <span className="api-desc"> — {String(prop.description)}</span> : null}
          {depth < 2 && !prop.$ref && (properties(prop).length > 0 || properties(prop.items as Json | undefined).length > 0 || !!prop.oneOf) && (
            <SchemaView schema={prop.type === "array" ? (prop.items as Json) : prop} schemas={schemas} depth={depth + 1} />
          )}
        </li>
      ))}
      {schema.additionalProperties ? (
        <li className="api-desc">
          … <span className="api-type">{typeof schema.additionalProperties === "object" ? typeText(schema.additionalProperties as Json) : "any"}</span>
        </li>
      ) : null}
    </ul>
  );
}
const SchemaLink = ({ name }: { name: string }) => <a href={`#schema-${name}`}>{name}</a>;

export default async function ApiDocs() {
  const t = await serverT();
  const doc = openApiDocument();
  const info = doc.info as Json;
  const schemas = (doc.components as { schemas: Schemas }).schemas;
  const tags = doc.tags as { name: string; description?: string }[];
  const paths = doc.paths as Record<string, Record<string, Json>>;
  const operations = Object.entries(paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })));
  const server = (doc.servers as { url: string }[])[0]?.url;
  const labels: Record<string, ReactNode> = {
    parameters: t("Parameter", "Parameters"),
    body: t("Anfrage", "Request body"),
    responses: t("Antworten", "Responses"),
    required: t("Pflicht", "required"),
    writeToken: t("Schreib-Token", "write token"),
    noAuth: t("ohne Token", "no token"),
  };
  return (
    <main className="public-page api-docs">
      <style>{css}</style>
      <a href="/" className="public-brand">
        flowplan <span className="muted">/ API</span>
      </a>
      <h1>{String(info.title)}</h1>
      <p className="muted">
        {t("Version", "Version")} {String(info.version)} · <a href="/api/openapi.json">openapi.json</a> ·{" "}
        <a href={String((doc.externalDocs as Json).url)}>{t("Anleitung", "Guide")}</a> ·{" "}
        {t("Server", "Server")} <code>{server}</code>
      </p>
      <Text text={String(info.description)} />
      <nav className="api-nav" aria-label={t("Bereiche", "Sections")}>
        {tags.map((tag) => (
          <a key={tag.name} href={`#tag-${tag.name.replace(/\W+/g, "-")}`}>
            {tag.name}
          </a>
        ))}
        <a href="#schemas">{t("Schemas", "Schemas")}</a>
      </nav>
      {tags.map((tag) => {
        const ops = operations.filter(({ op }) => (op.tags as string[])?.includes(tag.name));
        if (!ops.length) return null;
        return (
          <section key={tag.name} id={`tag-${tag.name.replace(/\W+/g, "-")}`}>
            <h2>{tag.name}</h2>
            {tag.description && <Text text={tag.description} />}
            {ops.map(({ path, method, op }) => {
              const params = (op.parameters as Json[]) || [];
              const body = op.requestBody as { required?: boolean; content: Record<string, { schema?: Json }> } | undefined;
              const responses = op.responses as Record<string, { description: string; content?: Record<string, { schema?: Json }> }>;
              const security = (op.security as Json[]) || [];
              return (
                <article key={String(op.operationId)} id={String(op.operationId)} className="api-op">
                  <h3>
                    <span className={`api-method ${method}`}>{method.toUpperCase()}</span> <code>{path}</code>
                    {op["x-write-token"] ? <span className="api-badge">{labels.writeToken}</span> : null}
                    {!security.length ? <span className="api-badge">{labels.noAuth}</span> : null}
                  </h3>
                  <p>
                    <strong>{String(op.summary)}</strong>
                  </p>
                  {op.description ? <Text text={String(op.description)} /> : null}
                  {params.length > 0 && (
                    <>
                      <h4>{labels.parameters}</h4>
                      <table className="api-params">
                        <tbody>
                          {params.map((prm) => (
                            <tr key={`${prm.in}-${prm.name}`}>
                              <td>
                                <code>{String(prm.name)}</code>
                              </td>
                              <td className="muted">{String(prm.in)}</td>
                              <td className="api-type">{typeText(prm.schema as Json)}</td>
                              <td>
                                {prm.required ? <span className="api-required">{labels.required}</span> : null} {prm.description ? String(prm.description) : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  {body &&
                    Object.entries(body.content).map(([type, content]) => (
                      <div key={type}>
                        <h4>
                          {labels.body} <code>{type}</code>
                        </h4>
                        <SchemaView schema={content.schema} schemas={schemas} />
                      </div>
                    ))}
                  <h4>{labels.responses}</h4>
                  <ul className="api-responses">
                    {Object.entries(responses).map(([status, response]) => {
                      const content = response.content ? Object.entries(response.content)[0] : null;
                      return (
                        <li key={status}>
                          <code>{status}</code> {response.description}
                          {content ? (
                            <span className="api-desc">
                              {" "}
                              · <code>{content[0]}</code> {content[1].schema ? <SchemaView schema={content[1].schema} schemas={schemas} depth={1} /> : null}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </article>
              );
            })}
          </section>
        );
      })}
      <section id="schemas">
        <h2>{t("Schemas", "Schemas")}</h2>
        {Object.entries(schemas).map(([name, schema]) => (
          <article key={name} id={`schema-${name}`} className="api-schema">
            <h3>
              <code>{name}</code>
            </h3>
            {schema.description ? <Text text={String(schema.description)} /> : null}
            <SchemaView schema={schema} schemas={schemas} />
          </article>
        ))}
      </section>
    </main>
  );
}

const css = `
.api-docs { max-width: 60rem; }
.api-docs code { font-size: 0.92em; }
.api-nav { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; margin: 1.5rem 0; }
.api-op, .api-schema { padding: 1rem 0; border-top: 1px solid var(--border, #ddd); }
.api-op h3, .api-schema h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
.api-op h4 { margin: 1rem 0 0.3rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #666); }
.api-method { display: inline-block; min-width: 3.6em; padding: 0.1em 0.5em; border-radius: var(--radius, 6px); font-size: 0.75rem; font-weight: 600; text-align: center; background: var(--hover, #eee); }
.api-method.post { background: var(--blue-light, #e4ecf7); color: var(--blue, #2a5aa0); }
.api-badge { margin-left: 0.5rem; padding: 0.1em 0.5em; border: 1px solid var(--border, #ddd); border-radius: 999px; font-size: 0.72rem; font-weight: 500; color: var(--muted, #666); }
.api-params { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
.api-params td { padding: 0.25rem 0.6rem 0.25rem 0; vertical-align: top; border-bottom: 1px solid var(--border, #eee); }
.api-props, .api-variants, .api-responses { margin: 0.2rem 0 0.2rem 0; padding-left: 1.2rem; font-size: 0.92rem; }
.api-props li, .api-responses li { margin: 0.15rem 0; }
.api-type { color: var(--muted, #666); }
.api-desc { color: var(--muted, #666); }
.api-required { color: var(--blue, #2a5aa0); font-size: 0.8em; }
`;
