# What goes through the plugin and what we draw in code

An agreement between developers and designers on which assets travel through `FigmaImageExporter` (and end up in `.xcassets` and the `FigmaImageAssets` enum), and which stay on the code or system side.

The goal is twofold: don't multiply PNGs for things that live perfectly well in code, and don't blur the line between "illustration" and "UI primitive".

---

## Don't put through the plugin

These should **not** appear in the Figma file with the `img_exp/` prefix and should not be marked by the plugin. If something like this lands in your input — send it back to the designer or delete it.

### 1. System resources

Anything macOS can already hand you via its own APIs:

- application icons,
- file previews,
- folder icons,
- any asset that's visible in Finder.

Pull them via `NSWorkspace`, `NSImage(named:)` with system names, `QLThumbnail`, etc.

### 2. Text and labels

Any caption is a system `NSTextField` / `NSAttributedString` with a font and color from the design tokens. Never turn it into a PNG, even if the mockup shows it as "a label with fancy typography".

### 3. Simple shapes with a flat fill

A circle, rectangle, rounded rectangle, plain single-color block — all drawn in code (`NSBezierPath`, `CALayer`, SwiftUI shapes). The "simple" criterion here:

- one fill, one color (or a single color from the FigmaColor tokens),
- no gradient,
- no shadow,
- no stroke.

A flat color fill is not a reason for a PNG.

### 4. Elements with a stroke

Buttons, "fill + border" regions defined via a style. It doesn't matter whether the colors are flat or gradient — as long as it fits the "shape + stroke" pattern, the developer draws it directly.

### 5. Large backgrounds

If an asset only needs `1x` or only `2x` (without a retina pair) — the plugin now supports this directly: mark the layer as `img_exp/1x/<name>` (only `@1x`) or `img_exp/2x/<name>` (only `@2x`). Details are in `designer_manual.md`, in the density-marker section.

---

## Do put through the plugin

Through `img_exp/...` (or a manual tag in tagged mode) goes everything that is **cheaper to ship as a picture** than to rewrite in code.

### 1. Arbitrary complex-shape figures

Things that aren't described by one or two Bézier curves. If reproducing it in code turns into a hundred lines of `move(to:)` / `curve(to:)` — that's a PNG.

### 2. Multi-color complex illustrations

Illustrations that simultaneously combine many colors, shapes, layers, and effects. Device previews, mascots, spot illustrations for empty states, complex badges, and so on.

### 3. Complex gradients

Multi-stop / conical / mesh gradients and any others that are expensive or impossible to assemble via `NSGradient` / `CAGradientLayer` without quality loss. A simple linear two-color gradient does not belong here — draw it in code.
