# stlv

A lean image editor for macOS: Photoshop's everyday tools, nothing niche, in the TSR-1 look.

```
open dist/stlv.app            # run the built app
mac/build.sh                  # build dist/stlv.app (~1 MB, a few seconds)
mac/build.sh --test           # build, then run the test suite headless in WebKit
mac/build.sh --run            # build and open
```

No downloads, no npm, no Node, no Rust: a small Swift shell (`mac/main.swift`) hosts the editor (`app/`, plain JavaScript ES modules) in a WebKit view. The only tools needed are the Swift compiler and `iconutil` from the Command Line Tools. Everything is our own code, with no third-party libraries and nothing GPL.

Working on the editor in a browser: start the `stlv-app` preview (`tools/devserver.py 8770 stlv/app`), open `http://localhost:8770/`, and add `?test=1` to run the tests. Files open through the browser's file picker and save as downloads.

## What's in it

| | |
|---|---|
| New document | Presets (Photo, Print, Screen, Social, Recent), px / in / cm / mm / pt, ppi, orientation, background, memory readout |
| Layers | Pixel, text, gradient / solid fill, adjustment layers, groups (pass-through or a blend mode), masks (paint, reveal / hide / from selection, invert, apply), clipping masks, opacity + fill, locks, drag to reorder, merge down / visible, flatten, duplicate, rasterize |
| Blend modes | All 27 of Photoshop's (Normal … Dissolve, Darken group, Lighten group, Overlay / light group, Difference group, Hue / Saturation / Color / Luminosity), on the GPU |
| Selections | Rectangle, ellipse (fixed ratio / size), lasso (freehand / polygonal), selection brush, add ⇧ / subtract ⌥ / intersect ⇧⌥, inverse, reselect, feather, expand, contract, smooth, border, load layer pixels, move the outline |
| Painting | Brush and eraser (opacity vs flow, pressure, smoothing, spacing, hardness, 5 tips, paint modes), fill bucket (tolerance, contiguous, all layers), gradient tool (pixels or fill layer), eyedropper, Fill and Stroke selection |
| Gradients | One editor for the tool, fill layers and the gradient overlay style: colour + opacity stops (transparent anywhere, no grey fringe), midpoints, presets, linear / radial / angle / reflected / diamond, dither |
| Text | Point and box text, every installed font and style, pt sizes via ppi, tracking, leading, alignment, caps, colour. The font list previews each font on the text as you hover or press ↑↓, and new text uses the last text colour you picked. It stays editable after transforms and warps (arc, bulge, flag, wave, fish, rise, inflate, squeeze, twist…) |
| Transform | Free transform (scale / rotate / skew, numeric W / H / angle), distort, perspective, warp (Bézier grid or presets), flips and 90° rotations, a lifted floating selection, nearest / bilinear / bicubic |
| Resize | Image size with resample methods (nearest, bilinear, bicubic, smoother, sharper, automatic), canvas size with anchor + extension colour, crop (ratios, W × H @ ppi, delete or keep cropped pixels), trim, rotate / flip canvas |
| Content-aware | Content-aware scale for a layer or the whole canvas (seam carving, protect a selection or opaque areas, amount) |
| Adjustments | Brightness / Contrast, Levels (histogram, auto), Curves (RGB + channels), Hue / Saturation (colorize), Vibrance, Black & White (tint), Invert, Threshold, Dehaze, all as adjustment layers or one-offs |
| Filters | Gaussian, Box, Motion, Zoom, Spin blur; Mosaic, Crystallize, Color Halftone; ASCII, Code Rain, Point Cloud. Live (editable, re-runs when the layer changes) or applied to pixels |
| Rulers / guides | Rulers in px / in / cm / mm / pt / %, drag guides out of the rulers, new guide, guide layouts, lock / clear, snapping to guides, canvas and layers, grid, pixel grid |
| Files | `.stlv` (lossless, everything editable), open PNG / JPG / WebP / GIF / BMP / TIFF / HEIC / PSD, place images (fit / fill / stretch / original), copy / paste (incl. merged, in place) |
| Export | PNG (ppi + sRGB written), JPG (quality, matte, ppi), WebP (lossless), PSD (layers, groups, masks, modes, guides), PDF (physical size, JPEG or lossless, bleed, crop marks); canvas, selection or each layer; scale + resample; trim |
| Finder | Quick Look extensions (`mac/ql/`): .stlv files show their image as the Finder icon and in the spacebar preview, from the 2048 px composite every save stores |
| Safety | Undo / redo with a History panel, autosave every minute + crash recovery, unsaved-changes prompts |
| Look | The seven TSR-1 skins (mono, violet, paper, terminal, ember, ice, wyrm) |

## Known limits

- **8-bit RGB only.** No CMYK or 16-bit.
- **WebP export is lossless only.** Neither WebKit nor macOS can encode lossy WebP, so stlv writes WebP with its own lossless encoder.
- **PSD export:** text, fill layers, styles and live filters are written as pixels. Adjustment layers only show in the merged image. PSD import reads the pixel layers (text becomes pixels) and skips adjustment layers. 8-bit RGB and grayscale PSD only, no PSB.
- **Text:** one style per text layer (no mixed fonts inside one layer).
- **Filters run on the CPU.** While you drag a slider they preview at reduced size, then render full size when you let go.
- **Content-aware scale** is shown as a quick quarter-size preview; full resolution renders on ↩.

## Layout

```
mac/        main.swift (shell, menus, panels, files, fonts, clipboard), build.sh, Info.plist, icon
mac/ql/     Quick Look thumbnail + preview extensions (read composite.png from the .stlv zip)
app/js/     doc (model + undo), compositor + gl (WebGL2), view, selection, blur, text, transform,
            gradient, adjust, filters, seamcarve, commands, tools/*, ui/*, io/* (stlv, psd, webp, pdf, zip...)
app/tests/  tests.js (the suite), demo.js (a sample poster for trying things)
tools/      devserver.py (browser dev server)
```
