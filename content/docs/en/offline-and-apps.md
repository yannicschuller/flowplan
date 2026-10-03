# Offline, web app and desktop

Flowplan runs in the browser, can be installed as an app and keeps working without a connection.

## Work without a connection

Flowplan always saves documents locally in the browser first (IndexedDB) and syncs them with the server as soon as it can be reached. If the connection drops, you simply keep writing; other people's changes are merged when you reconnect.

### Turn on offline use

Under **Settings → Data → Offline use**, the device also stores the app, the workspace, all readable pages and files you open later. Then you can open pages, read documents and databases and edit text even without a connection.

- Online, the current state always comes from the server; the copy only serves without a connection.
- The copies contain private content. They are removed when you sign out, when you turn the feature off and when another person signs in.

### Database records offline

Changes to records without a connection appear in the views right away and are collected on the device. As soon as the connection is back, they go to the server one after another. If someone changed the same record in the meantime, Flowplan merges the changes field by field; if the same field was changed on both sides or the record was deleted, you decide in the conflict dialog.

> [!NOTE]
> A database's schema – properties and views – can only be changed with a connection.

## Install as an app

- **Chrome, Edge**: the install icon in the address bar.
- **Safari on the Mac**: **File → Add to Dock**.
- **iPhone, iPad**: Share → **Add to Home Screen**. Only this way are push notifications possible there.
- **Android**: menu → **Install app**.

The installed app opens in its own window without browser bars.

### Share to Flowplan

When Flowplan is installed as an app on Android (Chrome), it appears in the **Share** menu of other apps. Shared text and links land in a preview; **Save as page** creates a page from it in the chosen space. Without being signed in, you first go to the sign-in and then back to the preview. iOS does not offer this menu to web apps.

For links, the preview asks whether to save them **as a page** or **as a bookmark**. **Take the article text** loads the web page on the server and keeps its main text without navigation, ads and scripts (public addresses only).

### Web clipper in the browser

Under **Settings → Data → Web clipper and bookmarks** you find the button **Save to Flowplan**. Dragged into the bookmarks bar, it opens a small window on any web page with the title, address and selected text – the same preview as when sharing. After saving, the window closes.

### Bookmarks

Bookmarks land in the **Bookmarks** database of the chosen space; it is created the first time, with link, website, folder, note, date and "read" as well as the views All, Cards and Unread. The article text that was taken along is in the record. **Choose bookmarks file** imports the HTML file that Chrome, Edge, Firefox and Safari create when exporting bookmarks – including folders and dates; links that already exist are skipped.

## Desktop app for macOS and Windows

A slim desktop app wraps your Flowplan instance. On first start it asks for the address (e.g. `https://flowplan.example.com`); **Switch server …** in the menu changes it later.

- All data stays on the server.
- The app remembers the window size and position and opens external links in the default browser.
- Without a connection it shows an offline page of its own; offline use of the web app works as in the browser.

You get the installation files from your administrators. As long as they are not signed, macOS asks on first opening (right-click → Open) and Windows shows SmartScreen. How to build them is described under [Operations and troubleshooting](/docs/operations#build-the-desktop-app).

## Light and dark

Under **Settings → General → Appearance** you choose light or dark. The start page and this documentation follow your system's setting.
