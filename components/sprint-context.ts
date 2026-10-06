"use client";
// The sprints of the database being shown, for sprint cells (names and choices).
import { createContext, useContext } from "react";
import type { Sprint } from "@/lib/database-settings-schema";

export const SprintContext = createContext<Sprint[]>([]);
export const useSprints = () => useContext(SprintContext);
