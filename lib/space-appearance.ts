import { z } from "zod";
export const spaceColors = [
  ["none", "Ohne Farbe"],
  ["gray", "Grau"],
  ["brown", "Braun"],
  ["orange", "Orange"],
  ["yellow", "Gelb"],
  ["green", "Grün"],
  ["blue", "Blau"],
  ["purple", "Violett"],
  ["pink", "Rosa"],
  ["red", "Rot"],
] as const;
export const spaceColorSchema = z.enum(spaceColors.map(([value]) => value));
export const spaceIconSchema = z.string().min(1).max(30);
