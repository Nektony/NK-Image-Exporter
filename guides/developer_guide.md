# FigmaImageExporter — developer guide

This document is for the **macOS developer who integrates the plugin's output** into their Xcode project and consumes the generated assets in code. For instructions to the designer, see [`designer_manual.md`](designer_manual.md). The guide to the plugin itself (how to build and modify it) is a separate document.

> **Platform: macOS only.** The generated `Contents.json` uses `idiom: "mac"`, the generated Swift returns `NSImage` (AppKit). The plugin in its current form is **not suitable** for iOS / iPadOS / `UIImage` — that would need a separate convention and a different `idiom`.

---

## 1. What's in the ZIP

After an export, the designer hands you `images.zip`. Inside there are **one or more** wrapper folders (one per Set):

```
images.zip
├── <SetName1>FigmaImageAssets/
│   ├── <SetName1>FigmaImageAssets.swift              ← generated enum
│   ├── <SetName1>FigmaImageAssets_images_sizes.json  ← sizes manifest (for NKExtraCompilationTool)
│   └── <SetName1>FigmaImageAssets.xcassets/          ← regular Asset Catalog
│       ├── Contents.json
│       ├── Preview/
│       │   ├── Contents.json
│       │   ├── nk_<setname1>_macbook.imageset/
│       │   ├── nk_<setname1>_macbookLock.imageset/
│       │   └── …
│       └── …
└── <SetName2>FigmaImageAssets/                       ← only present if the designer did a multi-set export
    └── …
```

`<SetName>` is the bundle name:
- In a regular (single-set) export — what the designer typed into the **Set Name** field in the plugin.
- In a multi-set export (when the page contains several `img_exp/SetName:…` frames) — each name is taken directly from the corresponding frame. A single `images.zip` then carries multiple wrappers at once.

In both cases, the list of `<SetName>` values is agreed on with the team (e.g. `Common`, `App`, `Sidebar`) — so the paths in the Xcode project are predictable.

`nk_<setname>_` is a per-asset namespace that protects against collisions with system bundles or third-party ones. So if your project already has an `icon_back` from some pod, our `nk_common_iconBack` won't clash with it.

> **1x-only / 2x-only assets.** The designer can mark an individual asset with `img_exp/1x/foo` (only `@1x`) or `img_exp/2x/foo` (only `@2x`) — for such an imageset the missing-density slot in `Contents.json` carries no `filename`, and the corresponding PNG is not on disk. There is no difference in Swift code: `imageName`, the `case`, and the raw value are the same. The size in `_images_sizes.json` is always in **points** — for a 2x-only asset the value is the 2x PNG dimensions divided by two.

---

## 2. Where to put the files in the Xcode project

### 2.1. Where to place the folder

Put `<SetName>FigmaImageAssets/` anywhere in the project — for example, `App/Resources/Figma/`. Layout:

```
App/
└── Resources/
    └── Figma/
        ├── CommonFigmaImageAssets_cached_images_sizes.json   ← created on the first build, see §4
        └── CommonFigmaImageAssets/                           ← from the ZIP, in full
            ├── CommonFigmaImageAssets.swift
            ├── CommonFigmaImageAssets_images_sizes.json
            └── CommonFigmaImageAssets.xcassets/
                └── …
```

### 2.2. What to add to the Xcode target

| File | In target? |
|------|------------|
| `<SetName>FigmaImageAssets.swift` | **Yes** — add to your target as a regular Swift file. |
| `<SetName>FigmaImageAssets.xcassets` | **Yes** — Xcode picks it up as an Asset Catalog. |
| `<SetName>FigmaImageAssets_images_sizes.json` | **No** — this is a service file used by the build-time check (NKExtraCompilationTool reads it itself). Just leave it in the file system. |
| `<SetName>FigmaImageAssets_cached_images_sizes.json` | **No** — also a service file, but **must be committed to git** (see §4). |

### 2.3. Don't touch the folder layout by hand

The contents of `<SetName>FigmaImageAssets/` are regenerated wholesale on every export from the designer. Any edits inside (renamed an asset, tweaked `Contents.json`, edited the `.swift`) **will disappear** on the next update.

If something needs to change — that's a request to the designer (fix it in Figma and re-export) or to the plugin developer (change the codegen).

---

## 3. Using the assets in code

### 3.1. The basic case

```swift
import AppKit

imageView.image = CommonFigmaImageAssets.preview_macbookLock.image
```

That's it. No `NSImage(named: "icon_back")` with stringly-typed names — you get autocomplete and compiler verification.

### 3.2. How the case name is read

`<lowerFolder1>_<lowerFolder2>_..._<camelCaseLeaf>` — folders in Figma become prefixes, the layer name becomes the last segment in lowerCamelCase:

| In Figma                              | In Swift                          |
|---------------------------------------|-----------------------------------|
| `Preview/img_exp/macbook-lock`        | `preview_macbookLock`             |
| `Mobile/Toolbar/img_exp/icon-back`    | `mobile_toolbar_iconBack`         |
| `img_exp/ai-state` (no folder)        | `aiState`                         |

### 3.3. All assets at once — `CaseIterable`

```swift
// DEBUG: assert-walk over every asset — catches a "lost" asset early.
#if DEBUG
CommonFigmaImageAssets.debugExistanceCheck()
#endif

// Iteration is fine
for asset in CommonFigmaImageAssets.allCases {
    print(asset.imageName, asset.image?.size as Any)
}
```

It makes sense to call `debugExistanceCheck()` from `applicationDidFinishLaunching(_:)` under `#if DEBUG` — it will trip an assert if any enum case can't find its PNG in the bundle.

### 3.4. What's inside `imageName` and why it looks that way

```swift
var imageName: String { "nk_common_\(rawValue)" }
```

`imageName` is a ready-to-use string for `NSImage(named:)`. The `nk_common_` prefix is assembled automatically. As a consumer you don't need it directly — work with the `case`s.

`rawValue` is the camelCase name without the prefix and without the hierarchy (e.g. `"macbookLock"`). It matches what the designer sees in the layer name after normalization. Use it if you need to compare against something external.

### 3.5. Asset deletion on the designer's side

If the designer removes an icon from Figma → in the next export the `case` disappears → the compiler will show you where it's still being used. That's a **feature**, not a bug — you spot the issue immediately and don't carry a dead reference into production.

---

## 4. Build-time size check (NKExtraCompilationTool)

The plugin places a `<SetName>FigmaImageAssets_images_sizes.json` file inside each bundle:

```json
{
  "preview_macbook":     { "width": 320, "height": 240 },
  "preview_macbooklock": { "width": 320, "height": 240 },
  "preview_aistate":     { "width":  24, "height":  24 }
}
```

This is "the current sizes of every asset". The keys are Swift case names, **fully lowercased** (that's what the plugin does when generating the manifest). So the Swift case `preview_macbookLock` becomes the key `preview_macbooklock` in the JSON manifest. The companion package `NKExtraCompilationTool` runs on every Xcode build of the project and compares this file against a frozen cache `<SetName>FigmaImageAssets_cached_images_sizes.json` that lives **one level above** (outside the regenerated folder).

### 4.1. Hooking it up in Build Phases

In your target's **Build Phases**, add a **Run Script** step before **Compile Sources**:

```sh
"$SRCROOT/path/to/NKExtraCompilationTool/Sources/NKExtraCompilationTool/main.sh" \
    "$DERIVED_FILE_DIR" "$SRCROOT" "$SRCROOT"
```

`main.sh` finds every `*_images_sizes.json` in the project itself and runs the check. No per-bundle config required — it's automatic.

### 4.2. What the check does

- **No cache next to it** → creates one from the current sizes. Silently.
- **A new asset appeared** → adds an entry to the cache. Silently.
- **An asset was removed** → drops the entry from the cache. Silently.
- **Same asset, different size** → **build error directly in Xcode** with the asset name, the cached size, the current size, and the path to the cache.

All conflicts across all bundles are reported **in a single pass**, not one error per build.

### 4.3. When you hit the size error

The error text looks like this:

```
…/CommonFigmaImageAssets_images_sizes.json: error: image size changed for 'preview_domians':
cached 30x30, current 32x30. If this change is intentional, delete or edit
…/CommonFigmaImageAssets_cached_images_sizes.json.
```

Two scenarios:

- **The change was accidental** (the designer nudged the layer by a couple of pixels by mistake) → ask the designer to snap to integer coordinates and re-export. After the next export the build passes without any change on your side.
- **The change was intentional** (a UI element has a new size and everything is being adjusted to it) → open `CommonFigmaImageAssets_cached_images_sizes.json` and **delete the entry** for that asset (or edit the values manually). The next build will record the new size and stop complaining.

### 4.4. The cache file is versioned in git

`<SetName>FigmaImageAssets_cached_images_sizes.json` is committed to git like any other code. Changes to it go through code review — that ensures size "unfreezing" doesn't happen silently.

> If `<SetName>FigmaImageAssets/` lives in `Resources/Figma/`, the cache is at `Resources/Figma/CommonFigmaImageAssets_cached_images_sizes.json`. One level above the regenerated folder.

---

## 5. Multiple bundles in one project

You can keep arbitrarily many bundles in parallel. They can come either from separate exports (one Set per ZIP) or from a single multi-set export (several wrappers in one ZIP — you place them along the same paths as you would for separate exports).

```
App/Resources/Figma/
├── CommonFigmaImageAssets_cached_images_sizes.json
├── CommonFigmaImageAssets/                          ← shared icons
│   └── …
├── SidebarFigmaImageAssets_cached_images_sizes.json
└── SidebarFigmaImageAssets/                         ← sidebar-specific
    └── …
```

Each one has its own `nk_<setname>_` namespace, its own enum, its own `.xcassets`. They **don't overlap** and update independently. In code:

```swift
imageView.image = CommonFigmaImageAssets.preview_macbookLock.image
sidebarIcon.image = SidebarFigmaImageAssets.toolbar_settingsIcon.image
```

NKExtraCompilationTool finds every bundle on its own via `find` — no per-bundle configuration needed.

---

## 6. Update workflow

When the designer ships a fresh ZIP:

1. **Delete** the old `<SetName>FigmaImageAssets/` folder in full.
2. **Unpack** the new ZIP and put the folder in the same place.
3. **Don't touch** `<SetName>FigmaImageAssets_cached_images_sizes.json` (it's one level up) — it will update itself on the next build if there are no conflicts.
4. **Build the project** — if NKExtraCompilationTool didn't complain, you're good; new assets are available through autocomplete.
5. **Commit** — both the ZIP folder and (if the cache changed) the updated `_cached_images_sizes.json`.

If anything was added or removed, the compiler will show you where things don't line up in code.

---

## 7. What's better not to do

- **Don't hand-edit** the contents of `<SetName>FigmaImageAssets/`. Any edits will disappear on the next export from the designer.
- **Don't strip the namespace prefix `nk_<setname>_`** from assets in `.xcassets` — `imageName` in Swift assembles it automatically and expects to find it on disk. Strip it and everything breaks at runtime.
- **Don't enable `Provides Namespace`** on folders inside `.xcassets` — the current contract is that folders are purely organisational, and `NSImage(named:)` finds an asset by its flat name with the prefix. Enable it and Xcode will start requiring the full path, and `imageName` will stop resolving.
- **Don't do stringly-typed `NSImage(named: "nk_common_iconBack")`** — that defeats the entire point of the codegen. Use the `case`s.
- **Don't ignore the size error from NKExtraCompilationTool.** It always means one of two things: the designer accidentally broke the size, or the new size hasn't been agreed on. Silently un-freezing the cache is tech debt that will surface later.

---

## 8. Where to look next

- **Full architectural specification** (how the plugin works and what it produces) — [`CLAUDE.md`](CLAUDE.md)
- **Designer manual** (what to name and how, in Figma) — [`designer_manual.md`](designer_manual.md)
- **Agreement on what goes through the plugin in the first place** (vs. drawn in code or fetched from system APIs) — [`what_to_export.md`](what_to_export.md). Worth re-reading with the designer before bringing new assets into the Figma file.
- **NKExtraCompilationTool** (build-time checks, not just for sizes) — `/Users/zevs/repo/nektony/packages/NKExtraCompilationTool/`
