# Third-party notices

Flowplan is free software under the [GNU AGPL-3.0](LICENSE). This file lists third-party software that Flowplan ships as a whole, outside its npm dependencies (whose licences come with each package in `node_modules`). The fonts in `public/fonts` carry their licences next to them (`LICENSE-*.txt`).

## draw.io

The Docker image ships the draw.io web app, the diagram editor of Flowplan's draw.io block (served under `/drawio/<version>/`, #454). It is not part of this repository: `scripts/drawio-fetch.mjs` downloads the release pinned in `scripts/drawio.json` from <https://github.com/jgraph/drawio/releases>, checks its SHA-256 and keeps the parts the embed mode needs, unchanged. Flowplan replaces only `js/PreConfig.js`, draw.io's file for a deployment's settings (`lib/drawio-bundle.ts`).

- Project: jgraph/drawio, <https://github.com/jgraph/drawio>
- Copyright (c) JGraph Holdings Ltd and draw.io AG
- Licence: Apache License, Version 2.0 – the full text is in [`licenses/drawio-LICENSE.txt`](licenses/drawio-LICENSE.txt) and in the shipped copy (`vendor/drawio/LICENSE`).

draw.io bundles further open-source components under their own licences, whose notices ship with it unchanged, among them: mxGraph (Apache-2.0), MathJax (Apache-2.0), DOMPurify (Apache-2.0 or MPL-2.0), pako (MIT and Zlib), JSZip (MIT or GPL-3.0), Rough.js (MIT), Mermaid (MIT), Eclipse Layout Kernel (EPL-2.0), jQuery (MIT) and libavoid-js (LGPL-2.1, `js/libavoid-js/LICENSE`, loaded as its own file so that it can be replaced). The icon and stencil libraries (`img/`, `shapes/`, `stencils/`) come with draw.io's own terms (`LICENSE` in each folder), which restrict their use in Atlassian products only; diagrams made with them are not restricted.
