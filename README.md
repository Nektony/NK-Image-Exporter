# NK Image Exporter

Figma plugin that batch-exports tagged layers as Xcode-ready `.imageset` assets — with automatic dark mode support.

## What it does

1. **Tag layers** — select any exportable layer in Figma and mark it as a named image
2. **Manage image list** — search, rename, and navigate to tagged layers across the document
3. **Export** — batch-export all tagged images on the current page as a single ZIP with Xcode-compatible `.imageset` folders

The exported ZIP is ready to drag into an Xcode Asset Catalog.

## Output format

```
images.zip
├── icon_settings.imageset/
│   ├── icon_settings.png          ← light 1x
│   ├── icon_settings@2x.png      ← light 2x
│   ├── icon_settings~dark.png    ← dark 1x (only if dark mode detected)
│   ├── icon_settings~dark@2x.png ← dark 2x
│   └── Contents.json
├── bg_header.imageset/
│   ├── bg_header.png
│   ├── bg_header@2x.png
│   └── Contents.json
└── …
```

Each `.imageset` contains a valid `Contents.json` with `idiom: "mac"` and proper scale/appearance entries.

## Dark mode

The plugin automatically detects dark mode variants and exports them alongside light versions. Two approaches are supported:

- **Mode-based** — variable collections with Light/Dark modes. The plugin switches the collection mode, exports, and compares the output
- **Name-based** — variables or paint styles prefixed with `Light/` and `Dark/`. The plugin swaps bindings on a temporary clone

If the dark export is pixel-identical to light, only light assets are included (2 files instead of 4).

## Installation

1. Clone or download this repository
2. Install dependencies and build:

```sh
npm install
npm run build
```

3. In Figma desktop app: **Plugins → Development → Import plugin from manifest…** → select `manifest.json`

## Development

```sh
npm run dev     # watch mode — rebuilds on file changes
npm run build   # production build
```

## Tech stack

- TypeScript + Figma Plugin API
- Webpack (code + UI bundled separately, UI inlined into a single HTML)
- [fflate](https://github.com/101arrowz/fflate) for ZIP creation

## How it works

- Image tags are stored as plugin data on each node (`pluginData`) and in a document-level registry on `figma.root`
- Image names must be unique across the entire document (all pages)
- Export scope is the current page only
- ZIP is delivered via data URI for reliability in Figma's Electron webview
- No external servers — everything runs locally inside Figma

## License

This project is licensed under the [MIT License](LICENSE) — free to use, modify, and distribute.

 ## About Nektony                                                                                                         
                                                                         
  Built and maintained by [Nektony](https://nektony.com) — we make focused Mac utilities, including [App Cleaner & Uninstaller](https://nektony.com/mac-app-cleaner), [MacCleaner Pro](https://nektony.com/mac-cleaner-pro), and [Disk Space Analyzer](https://nektony.com/disk-expert).                                                                  
                                                                         
  For other open-source work — methodology docs, CLI scripts — see our [GitHub organisation](https://github.com/Nektony).
