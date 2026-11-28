"use client";
// The record a linked database view sits in (#649, lib/this-record.ts), for
// the filter controls inside its DatabaseView. Every DatabaseView sets it
// (null outside a record's content), so a view nested in another – a record
// dialog opened from the linked view – never inherits its host's record.
import { createContext, useContext } from "react";
import type { ThisRecord } from "@/lib/this-record";

export const ThisRecordContext = createContext<ThisRecord | null>(null);
export const useThisRecord = () => useContext(ThisRecordContext);
