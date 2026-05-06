# FigmaImageExporter — designer manual

To get icons from Figma into our project automatically through the plugin, you need to follow a convention. Lay things out once — every export after that is a single button.

> **Before you start marking anything**, read [`what_to_export.md`](what_to_export.md) — it covers which assets we put through the plugin at all, and which ones developers draw themselves or fetch from the system. This document is about *how to mark*; that one is about *what to mark*.

---

## 1. Where to put the icons

Create a separate page or frame in the file — and put **only** the things that should end up in code there. Keep all variants of one asset (light, dark, hover, lock, etc.) next to each other — easier to review and update in one wave.

Example layout:

```
Dev page
├── Preview
│   ├── img_exp/macbook-light
│   ├── img_exp/macbook-dark
│   ├── img_exp/macbook-lock-light
│   ├── img_exp/macbook-lock-dark
│   ├── img_exp/ai-state
│   ├── img_exp/ai-hover
│   └── img_exp/domians
└── test_dir
    └── img_exp/group-domains-test
```

---

## 2. Naming convention — the essentials

> **The `img_exp/` prefix is mandatory.** Without it the plugin won't pick up the layer. Think of it as the marker "this picture is going into the project".

> **By default a layer is treated as the light theme.** No suffix needed.
> - `img_exp/icon` — this is the **light** version (default).
> - `img_exp/icon-light` — same thing, explicitly marked as light. Use it when you want to emphasize that a dark counterpart is required.
> - `img_exp/icon-dark` — the dark counterpart.

> **Light/dark pairing:**
> - `img_exp/icon-light` **must** have an `img_exp/icon-dark` next to it — otherwise you'll get the error `Light layers without a dark counterpart`.
> - `img_exp/icon-dark` **must** have either `img_exp/icon` or `img_exp/icon-light` nearby — otherwise `Dark layers without a light counterpart`.
> - `img_exp/icon` (no suffix) — the `-dark` pair is **optional**. If it's missing, the plugin will try to derive a dark variant from the variable collection's color tokens; if it can't, only the light one ships.

> **Density marker (optional):** between `img_exp/` and the name you can insert `1x/` or `2x/` — for assets that need **only** one density.
> - `img_exp/foo` — both densities (`@1x` + `@2x`), the usual case.
> - `img_exp/1x/foo` — `@1x` only. No retina pair.
> - `img_exp/2x/foo` — `@2x` only. No `@1x`.
> - The marker composes with light/dark: `img_exp/1x/foo-dark`, `img_exp/2x/bar-light`, etc. — all valid.
> - Light and dark must share the **same** density. `img_exp/foo-light` ↔ `img_exp/1x/foo-dark` is the error `Density mismatch in light/dark pair`.
> - The marker doesn't show up in the on-disk filename or in the Swift case. `img_exp/foo` and `img_exp/1x/foo` produce the same asset name and break the export with `Duplicate image names` — pick one form per asset.

---

## 3. What you can use in names

- Latin letters (`A-Z`, `a-z`), digits, `_`, `-`.
- Any other character (spaces, Cyrillic, dots, `/` other than the mandatory one in the prefix) gets automatically replaced with `_` on export.
- Case is preserved in filenames. In Swift, `snake_case` and `kebab-case` are normalized to `lowerCamelCase` — for example, `img_exp/macbook-lock` becomes `macbookLock` in code.
- **Don't duplicate names.** Two layers that normalize to the same string (e.g. `icon` and `icon-light` — both turn into `icon`) will break the export with the error `Duplicate image names`.

---

## 4. Frame hierarchy

Any frame / group / Section that contains an `img_exp/...` becomes a subfolder in `.xcassets`. This is convenient for developers — the structure in Figma is mirrored exactly in the project.

`Preview/img_exp/macbook` → `<set>.xcassets/Preview/macbook.imageset/`

Keep frame names in Latin too — Cyrillic gets turned into underscores.

---

## 5. The "Set Name" field in the plugin

On export you need to enter a **Set Name** — a short name for the bundle (e.g. `Common`, `App`, `Sidebar`).

- Latin letters/digits/`_` only, starts with a letter or `_`, no spaces.
- Can be left blank — then the bundle name falls back to the default.
- A project can host several bundles in parallel (`Common` for shared icons + a separate bundle for specific ones) — ask the developers what name to use for your bundle.

---

## 5b. Multiple bundles from one page (multi-set)

If you need to ship **several different Sets** from one page in a single export — do it via dedicated frames placed at the page root:

```
img_exp/SetName:Common      ← everything inside goes into the "Common" Set
img_exp/SetName:Sidebar     ← everything inside goes into the "Sidebar" Set
```

The frame name must start with `img_exp/SetName:`, followed by the Set name (same rules as the UI field: Latin letters/digits/`_`, starts with a letter or `_`, not a Swift keyword).

**Important rules:**

- These frames must sit at the **page root**. Inside another frame / group / Section a setname frame doesn't work (error `Nested SetName frame`).
- At the root you can have **either only setname frames or none of them**. If there's at least one setname frame plus a stray `img_exp/foo` next to it at the root — that's the error `Loose img_exp at root in multi-set mode`. Pick one mode.
- When setname frames are detected, the **Set Name field in the plugin is ignored** — the name comes from the frames.
- Two frames with the same `<SetName>` — error `Duplicate set name`.
- The contents of each setname frame are normal: subfolders, `img_exp/` layers, light/dark, density markers — everything works the same as inside a single Set. The `img_exp/SetName:Common` frame itself **does not** become a subfolder in `.xcassets` — it acts as a "wrapper", not as a folder.

The archive will contain several wrapper folders side by side — `CommonFigmaImageAssets/`, `SidebarFigmaImageAssets/`, etc. The developer just unpacks each one into its target location.

---

## 6. How to run an export

1. Open the **NK Image Exporter** plugin.
2. Enter a **Set Name** (e.g. `Common`).
3. Click **Export page (img_exp/)**.
4. An `images.zip` file will download — hand it to the developers.

---

## 7. What the plugin treats as an error

All errors are reported in the plugin with the full path to the offending layer — easy to locate.

- **Light layers without a dark counterpart** — `img_exp/X-light` exists but `img_exp/X-dark` does not.
- **Dark layers without a light counterpart** — `img_exp/X-dark` exists but neither `img_exp/X` nor `img_exp/X-light` does.
- **Density mismatch in light/dark pair** — light and dark have different density markers (e.g. `img_exp/foo-light` and `img_exp/1x/foo-dark`). Make them match.
- **Duplicate image names** — two layers produce the same name after normalization. Includes cases like: `img_exp/icon` + `img_exp/icon-light` both → `icon`; `img_exp/icon` + `img_exp/1x/icon` both → `icon`; `img_exp/1x/icon` + `img_exp/2x/icon` both → `icon`. Pick one form.
- **Image size validation failed** — the `@2x` version isn't exactly twice the `@1x` size, or the light size doesn't match the dark size. Most often this means the layer is offset by sub-pixels — try snapping it to integer coordinates.

**Multi-set mode errors** (when there are `img_exp/SetName:…` frames at the page root):

- **Loose img_exp at root in multi-set mode** — there's a regular `img_exp/foo` lying at the root next to an `img_exp/SetName:` frame. Move it inside one of the setname frames (or remove all setname frames to fall back to single-set mode).
- **Nested SetName frame** — an `img_exp/SetName:` frame is not at the root, but nested inside another frame. Move it up to the page root.
- **Duplicate set name** — two frames with the same `<SetName>` (e.g. `img_exp/SetName:Common` appears twice). Rename one.
- **Invalid set name** — in `img_exp/SetName:<X>` the name `<X>` isn't a valid Swift identifier (starts with a digit, contains a space/hyphen, or is a Swift reserved word). Fix it.

And separately — **not an error, but a warning after a successful export**:

- **"N images saved, but M required size correction"** — the export went through, the ZIP downloaded, but for some images the plugin had to nudge the `@2x` by 1 pixel (padding a transparent edge or cropping). Below the warning is a list of those images with the full layer-hierarchy path and was→became sizes. This means the source layer has a fractional width or height (e.g. 24.5 × 24), and Figma rounds the 1x and 2x renders differently. The auto-fix slows the export down significantly — fix the layer so its coordinates and dimensions are integers, and the next time the warning will be gone. This banner **does not auto-hide** — you need to read the list and act on it.

---

## 8. What's better not to do

- **Don't change the size of an already-exported icon** without coordinating with the developers. The plugin remembers sizes, and on the next export the Xcode build will fail with a clear error. This is a guard against accidentally drifting the UI layout.
- **Don't duplicate names** — `img_exp/icon` + `img_exp/icon-light` can't coexist.
- **Don't write names in Cyrillic** — the code will end up an unreadable mess of underscores.
- **Don't put an `img_exp/...` layer inside another `img_exp/...`** — the plugin doesn't descend into marked nodes, and the inner one will be lost.

---

If something is unclear or the plugin complains in a strange way — get in touch, we'll sort it out. Error messages always include the full path to the offending layer (page → frame → … → layer name).
