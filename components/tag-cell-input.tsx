"use client";
// A multi-select property with the workspace's tags as options (#79): the
// record's tags as coloured chips and "+ Tag" with the same combobox as on
// pages – it finds tags as one types and, for members with edit rights,
// creates the typed one (the server checks again).
import { useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { TagChip, TagPicker } from "./page-properties";
import { tagByName, useTagOptions } from "./tag-options-context";
import { foldName } from "@/lib/page-properties";
import type { Field } from "@/lib/types";

export function TagCellInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Field;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void | Promise<unknown>;
}) {
  const t = useT();
  const { tags, createTags } = useTagOptions();
  const [picking, setPicking] = useState(false);
  const current = (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string");
  // The options are the tags this person may know (all for members, the
  // ones of shared records for guests), with the tags' colours.
  const offered = (field.options || []).map((name) => tagByName(tags, name));
  const chosen = current.map((name) => tagByName(tags, name));
  const has = (name: string) => current.some((n) => foldName(n) === foldName(name));
  return (
    <span className="tag-cell-input" role="group" aria-label={field.name}>
      {chosen.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          onRemove={disabled ? undefined : () => void onChange(current.filter((n) => foldName(n) !== foldName(tag.name)))}
        />
      ))}
      {!disabled &&
        (picking ? (
          <TagPicker
            taxonomy={{ tags: offered, createTags }}
            exclude={chosen.map((tag) => tag.id)}
            onPick={(ref) => {
              const name = offered.find((tag) => tag.id === ref)?.name ?? ref.replace(/^#+/, "").trim();
              if (name && !has(name)) return onChange([...current, name]);
            }}
            onClose={() => setPicking(false)}
          />
        ) : (
          <button
            type="button"
            className="page-properties-add tag-cell-add"
            aria-label={t(`Tag zu „${field.name}“ hinzufügen`, `Add a tag to “${field.name}”`)}
            onClick={() => setPicking(true)}
          >
            <Plus size={13} aria-hidden /> {t("Tag", "Tag")}
          </button>
        ))}
    </span>
  );
}
