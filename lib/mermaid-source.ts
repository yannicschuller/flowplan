export const MAX_DIAGRAM_LENGTH = 20_000;
export const DEFAULT_DIAGRAM =
  "flowchart LR\n  A[Idee] --> B[Planung]\n  B --> C[Umsetzung]";
export function diagramSourceError(source: string): string | null {
  if (!source.trim()) return "Bitte Mermaid-Quelltext eingeben.";
  if (source.length > MAX_DIAGRAM_LENGTH)
    return "Das Diagramm darf höchstens 20.000 Zeichen enthalten.";
  // Configuration is controlled by the application; diagrams cannot enable callbacks,
  // inject CSS or fetch external resources while Mermaid measures their layout.
  if (/%%\s*\{|^\s*---/m.test(source))
    return "Konfigurationsdirektiven und YAML-Kopfbereiche werden nicht unterstützt.";
  if (/<\s*\/?[a-z!]|\bimg\s*:|\burl\s*\(|@import|@font-face/i.test(source))
    return "Bitte Textbeschriftungen ohne HTML, externe Bilder oder CSS-Ressourcen verwenden.";
  return null;
}
