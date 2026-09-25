# Flowplan Desktop (macOS und Windows)

Eine schlanke Electron-Hülle um eine Flowplan-Instanz – wie die
Desktop-Apps von Notion oder Slack. Alle Daten bleiben auf dem Server; die
App merkt sich die Adresse, das Fenster, bietet deutsche Menüs, öffnet Links
zu anderen Seiten im Standardbrowser und zeigt ohne Verbindung eine eigene
Offline-Seite. Offline-Nutzung, Benachrichtigungen und Tastenkürzel der
Web-App funktionieren unverändert.

Warum Electron und nicht Tauri: Electron bringt überall dasselbe Chromium
mit, in dem Flowplan entwickelt und getestet wird (Service Worker,
IndexedDB, Editor). Tauri nutzt die Webansichten des Systems (WebKit auf
macOS, WebView2 auf Windows) und bräuchte eine Rust-Toolchain; dafür wäre die
App deutlich kleiner (~10 MB statt ~110 MB).

## Entwickeln

```bash
cd desktop
npm install
npm start
```

Beim ersten Start fragt die App nach der Adresse der Instanz (HTTPS, für
lokale Tests auch `http://localhost:3000`). Ändern: Menü „Server wechseln …“.

## Bauen

```bash
npm run dist:mac   # DMG und ZIP für Apple Silicon und Intel (nur auf macOS)
npm run dist:win   # Installer (NSIS) und ZIP für Windows x64/arm64
```

Die Ergebnisse liegen in `desktop/dist`. Ohne Zertifikate bleiben die Apps
unsigniert: macOS fragt beim ersten Öffnen nach (Rechtsklick → Öffnen),
Windows zeigt SmartScreen. Für signierte Builds `CSC_LINK`/`CSC_KEY_PASSWORD`
setzen, für macOS zusätzlich `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` und
`APPLE_TEAM_ID` (Notarisierung).

Der Windows-Installer braucht NSIS; auf Apple-Silicon-Macs dafür Rosetta
(`softwareupdate --install-rosetta`) oder die CI-Aufgabe „Desktop Windows“,
die unter Linux mit Wine baut.

## Prüfen

```bash
node test/smoke.mjs http://127.0.0.1:3000
FLOWPLAN_APP="$PWD/dist/mac-arm64/Flowplan.app/Contents/MacOS/Flowplan" node test/smoke.mjs http://127.0.0.1:3000
```

Der Test startet die App mit leerem Profil, prüft die Einrichtung (falsche
Adresse wird abgelehnt, richtige lädt Flowplan) und die Offline-Seite.
