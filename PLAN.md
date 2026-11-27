# stlv: plan and logistics

stlv is a lean image editor. It covers what Photoshop does for everyday poster, flyer and social work, and leaves out the rest.
Clickable mockup: `stlv/mockup/index.html`. Run it with the `stlv` preview server, or open the file directly.

## 0. As built (2026-10-04)
The app exists: `dist/stlv.app` (build with `mac/build.sh`; see README.md). It differs from sections 2–3 below in these ways:
- **Shell:** a ~400-line Swift WKWebView shell (`mac/main.swift`), not Tauri. Node isn't installed and Homebrew's Rust is too old, and the shell needs nothing else. It provides native menus, open/save panels, the `stlv://` scheme for file bytes, system fonts, the clipboard and the app-data folder.
- **Editor code:** plain JavaScript ES modules with no build step, not TypeScript + Preact.
- **No third-party libraries:**
  - Our own zip writer (using WebKit's deflate), PSD reader/writer, PDF writer and WebP lossless (VP8L) encoder, in place of fflate, ag-psd and pdf-lib.
  - Lossy WebP is unavailable: neither WebKit nor ImageIO can encode it.
- **Filters run on the CPU:** live filters preview at reduced size while dragging. Adjustment layers, blending, gradients and transforms run on the GPU as planned.
- **Content-aware scale:** JavaScript in a Web Worker, not Rust → WASM. Each round extracts many seams at once, so a 50% change takes 2–5 rounds (about 0.2–0.7 s at 1–2 MP).
- **Tests:** `app/tests/tests.js` (30 tests), run in the browser (`?test=1`) and headless in WebKit (`mac/build.sh --test`). They cover the blend-mode reference sweep, every tool, every filter, file round trips and multi-seed undo fuzzing.
- **Measured** on a 4000 × 5000 doc with 9 layers: brush 3.5 ms per frame, full recomposite 20 ms.

## 1. Scope

### In v1 (must be stable)
| Area | What ships |
|---|---|
| New document | Presets in Recent / Photo / Print / Screen / Social. Width and height in px, in, cm or mm, plus resolution (ppi), orientation, RGB 8-bit and background (white / black / transparent / foreground / custom). It shows the pixel size and memory before you create. |
| Layers | Pixel, text, gradient-fill and solid-fill layers. Visibility, opacity, fill, lock, reorder, duplicate, merge down / visible, flatten, clipping mask. |
| Groups | Folders in the Layers panel, nestable. Blend mode Pass through by default, or a real mode, which then composites the group as one. Group opacity, visibility, lock and mask. ⌘G groups, ⇧⌘G ungroups. |
| Layer masks | One grayscale mask per layer or group: white shows, black hides. Paint it with brush, eraser, fill or gradient. Reveal all / hide all / from selection, ⇧-click disables, apply, delete. Linked to the layer by default. |
| Blend modes | Normal, Darken, Multiply, Color Burn, Linear Burn, Lighten, Screen, Color Dodge, Linear Dodge (Add), Overlay, Soft Light, Hard Light, Difference, Exclusion, Hue, Saturation, Color, Luminosity. |
| Selection | Rectangle and ellipse (fixed ratio / fixed size), lasso and polygonal lasso, and a selection brush. Each has new / add / subtract / intersect and feather. Select menu: all, deselect, reselect, inverse, feather, expand, contract, smooth, layer pixels. |
| Paint | Brush and eraser: size, hardness, opacity, flow, smoothing and pen pressure (size or opacity). Presets: round hard, round soft, airbrush, chalk, square. |
| Fill | Paint bucket: tolerance, contiguous, all layers, anti-alias. Edit → Fill fills a selection with foreground, background or a color. |
| Gradients | One editor with color and opacity stops, so any stop can be transparent, used in three places: the Gradient tool (draws pixels), the Gradient fill layer (editable, non-destructive) and the Gradient overlay layer style. Types: linear, radial, angle, reflected, diamond. |
| Text | Point and box text, any installed font, size in pt (converted with the doc's ppi), tracking, leading, alignment, color. Text stays editable. |
| Transform | Free transform (scale / rotate / skew), Distort, Perspective, and Warp with presets (arc, bulge, flag, wave, rise) or a free 3×3 Bézier grid. Flip and rotate 90°. |
| Resize methods | Resample method in Image size, Export and every transform: nearest neighbor (hard edges), bilinear, bicubic smoother (enlarging), bicubic sharper (reducing), automatic. Constrain proportions on or off. Place image: fit, fill, stretch, original size. |
| Content-aware scale | Edit → Content-aware scale works on one layer; Image → Content-aware resize works on the whole canvas. Stretching or squeezing only moves low-detail areas (sky, gradients, flat backgrounds), so subjects keep their shape. Protect by selection, Amount 0–100% blends with a plain scale, live preview while you drag. |
| Filters | **Blur:** Gaussian, Box, Motion (angle, distance), Zoom (amount, drag the center), Spin (angle, drag the center). **Pixelate:** Mosaic, Crystallize, Color halftone (max radius, C/M/Y/K screen angles 108/162/90/45 by default). **Code:** ASCII (cells across, picture dim, digit flicker, band, seed), Code rain (columns, density, trail, picture dim, seed). **Generative:** Point cloud (dots across, dot size, depth, turn, threshold, black or transparent background). The Code and Generative filters are ported from SB Machine, colored by the foreground / background swatches or by the image. Filters stay editable on the layer as live filters (re-open, re-tune, hide, reorder), or Filter → Apply bakes them into the pixels. They work on text without rasterizing it. They apply to the selected layer, or All visible (Photoshop's "stamp visible"), and respect the selection. |
| Adjustments | Brightness / Contrast, Levels (histogram, input black / midtones / white, output black / white), Curves (RGB + per channel, click to add points, drag off to remove), Hue / Saturation, Vibrance (+ saturation), Black & White (Photoshop's six color sliders, same defaults), Invert, Dehaze (−100 to +100; minus adds haze). Each is an adjustment layer (non-destructive, with its own mask, affects everything below it, or only its group or a clipped layer) or a one-off from Image → Adjustments. |
| Rulers and guides | Rulers in px, in, cm, mm or pt. Drag guides out of a ruler, or use New guide and New guide layout (columns, rows, margins). Guides can be locked or cleared. Snapping to guides, canvas edges / center and layer bounds. |
| Export | PNG (transparency, 8-bit option), JPG (quality, matte), WebP (lossy or lossless), PSD (layers, editable text) and PDF (physical size, bleed / crop marks). Scale 0.5×, 1× or 2× / custom, resample method, embedded ppi and sRGB, trim. Exports the canvas, the selection or each layer. Quick export PNG. |
| Files | The native `.stlv` format, plus open PNG / JPG / WebP / PSD. Autosave and crash recovery. |
| Workflow | Undo/redo with a History panel, zoom and pan, eyedropper, crop, color panel with swatches, Photoshop-style shortcuts. |

### Left out on purpose
Other filters (distort, noise, render, sharpen, stylize, filter gallery), CMYK, 16/32-bit, healing and clone, pen paths and shape layers, smart objects, actions, 3D, video timeline, plugins.


## 2. Stack

| Piece | Choice | Why |
|---|---|---|
| Language | TypeScript | Typed document model: refactors stay safe as features stack up |
| UI | Preact + signals (MIT, ~5 KB) | Panels and dialogs re-render cheaply; the canvas is not part of the UI tree |
| Pixels | One `OffscreenCanvas` (2D) per layer is the source of truth | Painting, flood fill, text rasterizing and selection masks are simple and reliable in Canvas2D |
| Compositing | WebGL2: one texture per layer, one blend-mode shader | Covers all 18 modes, including Linear Burn, which Canvas2D doesn't have. Warp, distort and perspective are mesh draws |
| App shell | Tauri 2 (MIT/Apache) → `stlv.app` | Native menus, file dialogs, drag-drop and the system font list. ~10 MB app instead of Electron's ~150 MB |
| PSD | `ag-psd` (MIT) | Read and write layered PSD with text |
| .stlv / zip | `fflate` (MIT) | `manifest.json` + one PNG per layer + thumbnail |
| PDF | `pdf-lib` (MIT) | Single-page image PDF at physical size |
| Content-aware | Own Rust → WASM crate (seam carving), in a Web Worker | Fast enough for a live preview, and portable to Windows |
| Tests | Vitest + Playwright | Unit math and golden-image tool tests |

**Platform (decided 2026-10-03):** Mac first. Windows may come later, so keep the code portable: no macOS-only APIs outside `src-tauri/`, file paths through Tauri's path API, and shortcuts written as `Mod` (⌘ on Mac, Ctrl on Windows). A Windows build should then need only a Tauri target and signing.

**Distribution (decided 2026-10-03):** in-house for now. The app is ad-hoc signed, like SB Machine, with no notarization or licensing work yet. Everything stays MIT/Apache with no GPL, so selling it later stays possible (the same rule as TSR-1).
It lives in `TSR1/stlv/`, fully separate from TSR-1 code (the same rule as SB Machine). During development it runs in the browser (`vite dev`); Tauri wraps the same build.

## 3. Architecture

```
stlv/
  src/
    doc/        Document, Layer, LayerStyle, Guide: plain data + versioned schema
    history/    command objects + tile-diff undo
    render/     WebGL2 compositor, blend shaders, transform/warp mesh, view cache
    raster/     brush engine, flood fill, selection mask ops, gradient rasterizer, text raster
    tools/      one file per tool: pointer events → commands
    io/         .stlv, PSD, PNG/JPG/WebP/PDF export, import, autosave
    ui/         menubar, options bar, toolbar, panels, dialogs, skins (Preact)
  src-tauri/    native shell
  tests/
```

- **Document model.** The document holds `{width, height, ppi, background, layers[], guides[], selection}`. A layer holds `{id, kind: pixel|text|gradientFill|solidFill, name, visible, opacity, fill, blend, locked, clip, style:{gradientOverlay?}, transform, warp?}`. Text and fill layers keep their parameters and are re-rasterized when edited.
- **Undo.** Each action is a command. Pixel commands store only the changed 256×256 tiles (before and after), not whole layers, so history stays small. 100 steps by default.
- **Rendering.** The view redraws only on change, never in a loop. While you paint on layer N, the layers below and above it are cached as two textures, so a brush dab redraws only three quads. Idle CPU is 0%.
- **Export uses the same compositor** at full resolution, so the file matches the screen exactly.
- **Selection.** An 8-bit mask the size of the document. Marching ants are traced from the mask edge. The selection brush paints straight into the mask and shows a red overlay while you paint.
- **Gradients.** Stops interpolate in premultiplied alpha. That is what makes "color → transparent" fade cleanly instead of through grey. Dithering prevents banding on 8-bit.
- **Warp.** The layer is drawn as a 32×32 mesh deformed by a bicubic Bézier patch. Perspective uses a homography. Interpolation is set per transform: nearest, bilinear or bicubic. Text stays editable under warp. Distort and perspective rasterize the text after a prompt, as Photoshop does.
- **Groups.** A group holds children. Pass through just flattens its children into the parent stack. Any other blend mode (or a group mask) renders the children into one offscreen texture first, then blends it as one layer, as Photoshop does.
- **Masks.** A mask is an 8-bit texture the compositor multiplies into the layer's alpha. It uses the same code as the selection mask, so every paint tool works on it unchanged.
- **Content-aware scale.** This is seam carving with forward energy (the method behind Photoshop's tool). Each step removes or duplicates the lowest-energy one-pixel path through the image. A selection or the layer's alpha becomes protection, which makes the protected pixels so expensive that no seam goes through them. Amount mixes the result with a plain bicubic scale.
  It is a small Rust crate compiled to WebAssembly and run in a Web Worker, so it works the same in the browser dev build and the app, off the UI thread. The preview runs on a ¼-resolution copy (~600×750), about 30–60 ms per update, so it follows the drag. Full resolution renders once you confirm: about 1–3 s for 2400×3000 at +50% width on an M-series Mac, with a progress bar. CPU use is that burst only, and nothing while idle.
- **Live filters.** A layer holds `filters[]` of `{type, params, visible}`. The compositor runs them in order on the layer's texture before blending, so editing a filter only re-runs that layer. The rendered result is cached until the layer or a parameter changes.
- **Adjustment layers.** A shader pass over the composite below it (inside its group, or only its clip base), multiplied by its mask. They are cheap: one full-screen pass each.
- **Filter math (GPU).**
  - Gaussian: separable, and on a downsample pyramid once the radius passes 32 px, so cost stays flat at any radius.
  - Box: two running-sum passes.
  - Motion, Zoom and Spin: average many sampled copies in two passes (coarse, then fine between the coarse steps), so a long blur never shows stepping.
  - Mosaic: average per cell.
  - Crystallize: a jittered-grid Voronoi, where each pixel checks only its 3×3 neighbouring cells. The seeds are fixed per layer, so the pattern doesn't shimmer as you edit.
  - Color halftone: an analytic dot per C/M/Y/K screen in the shader, with no geometry.
  - ASCII and Code rain: one glyph atlas texture, and each cell picks its glyph and brightness in the shader. A still has no clock, so SB Machine's time becomes a Seed and its beat sweep becomes a Band position.
  - Point cloud: one instanced quad per dot. The cells are sampled (half mean, half peak, as in SB Machine), pushed forward by brightness, turned, drawn back to front.
  - Brightness / Contrast, Levels and Curves: one 256-entry lookup each. Curves use monotone cubic interpolation, so there's no overshoot between points.
  - Vibrance: saturates around the pixel's average, with less push the more saturated the pixel already is.
  - Black & White: Photoshop's mix, min + (mid − min) × secondary weight + (max − mid) × primary weight.
  - Invert: 255 − value.
  - Hue / Sat: math in HSL space.
  - Dehaze: dark-channel prior (He et al.). The haze map is solved at ¼ size, edge-aware smoothed with a guided filter, then upsampled.
- **Filter preview.** Live while you drag. Big documents preview at screen resolution and render at full size on Apply / OK.
- **ppi.** Used for unit conversion (pt to px = pt × ppi / 72) and written into PNG `pHYs`, JPEG JFIF density, PSD resolution info and the PDF page size.

## 4. Limits and performance
- Max 12,000 px on a side. A 2400×3000 layer is 27.5 MB in RAM plus its GPU texture. The New document dialog warns when the estimated layer stack goes over 2 GB.
- Targets on an M-series Mac: brush latency under 8 ms (a dab is drawn within the same frame as the pointer event), 60 fps zoom/pan, and opening a 20-layer 4K document in under 1 s.
- Pen pressure works with any Pointer Events tablet (Wacom, Sidecar).
- Filter cost, measured in the mockup as plain JS (CPU) on a 770×963 preview: B/C 6 ms, Gaussian 7, Code rain 7, Levels 10, Vibrance 10, Mosaic 13, Curves 17, Point cloud 18, ASCII 27, Invert 30, Dehaze 32, Crystallize 35, B&W 38, Hue/Sat 42, Motion 55, Zoom 66, Halftone 68, Spin 69, Box 103. The app runs these as GPU shaders, so expect each to fit within a 60 fps frame at screen size. Full-size renders on Apply: well under 1 s each for 2400×3000. All of these are estimates until measured in the real app.
- Content-aware scale is limited to 2× growth (or shrinking to 25%) per pass. Beyond that seams repeat visibly; run it again if you need more.

## 5. Look
TSR-1 style. stlv uses TSR-1's own skins from `UI_THEMES` in `tsr01_poc.py`: mono (default), violet, paper, terminal, ember, ice and wyrm. The values are copied, not imported. Headers and labels use condensed caps (Barlow Condensed stands in for DIN Condensed), the accent glows on active tools, selected layers and primary buttons, guides glow cyan, and the pasteboard has TSR-1's 28 px grid. The picker is in the menubar, under Settings → Skin in the real app. The canvas itself is never tinted, so colors read true in every skin.

## 6. How "stable" gets proven
- **Blend modes:** each shader is checked against the W3C compositing formulas on a 256-value sweep (±1/255).
- **Golden images:** a scripted run of every tool (stroke, fill, gradient to transparent, warp arc, text) is compared pixel by pixel with reference PNGs, run on every change.
- **Undo fuzz:** 500 random actions, undo all, and the document must be byte-identical to the start. Then redo all, and it must match the end.
- **Round trips:** .stlv save → open is lossless. PSD export → import keeps layer count, blend modes, opacity and text.
- **Groups and masks:** golden images for pass-through vs. isolated groups, nested groups, and masks on layers and on groups.
- **Content-aware:** a protected region must come out pixel-identical, only shifted. Amount 0% must equal a plain bicubic scale.
- **Filters and adjustments:** goldens for each filter at three parameter settings. Gaussian is checked against a reference convolution (±1/255). Levels and Brightness / Contrast lookups are checked against the formulas. Applying a filter must match the live version pixel for pixel. Undoing a filter must restore the layer byte for byte.
- **Ported looks:** golden stills of ASCII, Code rain and Point cloud with the same seed must match SB Machine's frames at those settings. Same seed means the same picture every time.
- **Autosave:** every 60 s and on blur. A kill -9 mid-edit must reopen with at most 60 s lost.

## 7. Milestones
Each milestone ships only when its tests pass.

| # | Milestone | Done when |
|---|---|---|
| M0 | Shell: Tauri + Vite + menubar/panels from the mockup | App launches, menus and shortcuts route |
| M1 | New document dialog, canvas, zoom/pan, rulers, guides, snapping | Guides drag out of rulers, snap and save in the document |
| M2 | Layers + groups + WebGL compositor + 18 blend modes + undo core | Blend sweep tests pass; group goldens pass; undo fuzz passes |
| M3 | Brush, eraser, pressure, presets, eyedropper, color panel | Golden stroke tests; latency target met |
| M4 | Selections: rect, ellipse, lasso, polygonal, selection brush + Select menu; layer masks | Painting and fill respect the selection; ants are correct; mask goldens pass |
| M5 | Fill bucket + gradient editor / tool / fill layer / overlay | Golden "to transparent" test has no grey fringe |
| M6 | Text layers | pt↔px correct at 72 / 150 / 300 ppi; text stays editable after save/reopen |
| M7 | Free transform, distort, perspective, warp, image size, canvas size, place modes, crop, content-aware scale | Warp presets and resample modes match goldens; content-aware tests pass |
| M7b | Filters (blur ×5, pixelate ×3, code ×2, point cloud) as live filters + Apply; adjustment layers (B/C, Levels, Curves, Hue/Sat, Vibrance, B&W, Invert, Dehaze) | Filter goldens pass; live = applied; previews within one frame at screen size |
| M8 | .stlv save/open, autosave, PNG/JPG/WebP/PSD/PDF export, import | Round-trip tests pass |
| M9 | Hardening: memory limits, large-doc tests, crash recovery, ad-hoc signed .app | 1-hour soak with no leak; kill -9 recovery works |

## 8. Decisions log (2026-10-03)
- "Stretch modes" means resize methods. Content-aware scale is added as well.
- Groups and layer masks are in v1.
- Mac first; Windows maybe later, so keep the code portable.
- TSR-1 look with the same seven skins; mono is the default.
- In-house for now.
- Added filters (Gaussian, box, motion, zoom, spin blur; mosaic, crystallize, color halftone) and adjustments (brightness/contrast, levels, hue/sat, dehaze). Filters are live by default, and adjustments are adjustment layers.
- Confirmed Crystallize. Added Curves, Vibrance, Black & White and Invert, plus SB Machine's ASCII, Code rain and Point cloud (copied into stlv, not shared code).
