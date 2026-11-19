"use client";
// The published timeline in a chunk of its own: the other published pages
// (documents, tables, calendars) do not load it. Rendered on the server all
// the same.
import dynamic from "next/dynamic";

export const PublicTimelineGrid = dynamic(() => import("./public-timeline").then((m) => m.PublicTimelineGrid));
