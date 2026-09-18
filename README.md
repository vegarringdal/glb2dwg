# GLB to DWG

A single web page that turns a binary glTF model (`.glb`) into an AutoCAD drawing (`.dwg`).
Choose a file, get a download. The conversion runs in the browser tab, so models are never
uploaded anywhere.

**[Try it: vegarringdal.github.io/glb2dwg](https://vegarringdal.github.io/glb2dwg/)**

It works by compiling [GNU LibreDWG](https://www.gnu.org/software/libredwg/) to WebAssembly.
TypeScript reads the GLB and prepares the geometry; a small C file drives LibreDWG's add API.

## What you get

- **AutoCAD 2000 (R2000) DWG**, which is the newest format LibreDWG can write.
- **One layer per mesh**, named after the node or mesh in the glTF file, with a colour per layer.
- **Millimeters or meters**, your choice, with drawing extents set so CAD programs open zoomed
  to the model.
- **Z-up geometry** (optional), since glTF is Y-up and CAD is Z-up.

This archive ships with the WebAssembly module already built (`src/wasm/`) and a built site
(`docs/`), so you can serve `docs/` straight away, or run `npm install && npm run dev` without
installing Emscripten. `src/wasm/` is listed in `.gitignore`, since normally it is build output;
`docs/` is committed so GitHub Pages can serve it.

## Requirements

- Node.js 20.19 or newer.
- To build the WebAssembly module: the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
  (`emcc` on `PATH`), or Docker.

## Getting started

```sh
npm install
npm run build:wasm     # or: npm run build:wasm:docker
npm run dev
```

`build:wasm` downloads LibreDWG 0.13.4, verifies its checksum, applies the patches in
`native/patches/`, and compiles it together with `native/glb2dwg.c`. It produces two modules:
`src/wasm/` for the app, and `test/wasm/` which also contains LibreDWG's decoder so the tests can
read files back (that one is twice the size, which is why the app doesn't use it). The first
build takes a few minutes and is then cached; delete `native/build/` to start over.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks and builds the static site into `docs/` |
| `npm run preview` | Serves the built site |
| `npm test` | Runs the test suite (Node's test runner) |
| `npm run lint` | Biome check; `npm run lint:fix` writes fixes |
| `npm run typecheck` | TypeScript only |

The built site in `docs/` is static files. Any web server will do — no special headers needed.

The page footer shows the version from `package.json`. `vite.config.ts` reads it and passes it
on as `VITE_APP_VERSION`, so `npm run dev` and `npm run build` both show the same number; bump
the version in `package.json` to change it.

## Deploying to GitHub Pages

Asset URLs are relative (`base: './'` in `vite.config.ts`), so `docs/` works both at a domain
root and under a project path like `username.github.io/glb2dwg/`. Nothing needs configuring per
repository.

`npm run build` writes to `docs/`, which is committed, so the simplest way to publish is
Settings → Pages → Source: Deploy from a branch, branch `main`, folder `/docs` — which is how
[the demo](https://vegarringdal.github.io/glb2dwg/) is hosted. Rebuild and commit `docs/`
whenever you want the page updated. The `.nojekyll` file in `public/` (copied into
`docs/` at build time) stops Jekyll from interfering.

`.github/workflows/pages.yml` can do the same build on CI instead, if you would rather not commit
build output. It is manual-only (Actions → Deploy to GitHub Pages → Run workflow); uncomment its
push trigger and switch Settings → Pages → Source to GitHub Actions to publish from there on
every push to `main`. It caches the LibreDWG build between runs, since compiling it takes a few
minutes, and passes the repository URL as `VITE_SOURCE_URL` so the page links to its own source,
as the GPL asks. Building locally, set that variable yourself if you want the link
(see [Licence](#licence)).

## Units

glTF models are always in meters, which suits architectural and survey work. Most mechanical DWG
workflows expect millimeters, so that is the default: every coordinate is multiplied by 1,000 and
`$INSUNITS` is set to 4 instead of 6. Choosing meters keeps the model at glTF's own scale. The `UNITS` table in `src/convert.ts` is one line per unit if you
want centimeters or inches as well.

`$MEASUREMENT`, which picks a program's default hatch and linetype scales, is left alone:
LibreDWG stores it in a section it doesn't write for R2000.

## Mesh output options

**Polyface meshes** (`POLYLINE_PFACE`) store each vertex once and reference it from several
faces, which keeps the mesh connected. DWG polyface indices are signed 16-bit, so a mesh is
split whenever a piece would exceed 32,767 vertices or faces.

**3D faces** (`3DFACE`) write one entity per triangle. They carry no topology at all, which makes
them the most widely accepted option, so they are the default.

Polyface output is usually smaller, but not always: with heavily split vertices, the per-vertex
records can outweigh the savings. Both options describe exactly the same triangles.

## Layout

```
index.html          the page
src/main.ts         file input, options, status, download
src/worker.ts       runs the conversion off the main thread
src/convert.ts      layers, vertex welding, mesh splitting
src/glb.ts          GLB reader (node transforms, accessors, triangulation)
src/dwg-writer.ts   typed wrapper over the C functions
native/glb2dwg.c    the only C file: drives the LibreDWG add API
native/build.sh     downloads, patches and compiles LibreDWG to WebAssembly
native/patches/     patches applied to LibreDWG before building
test/               unit tests, plus end-to-end tests that write real DWG files
```

## What the converter does with a glTF file

- Applies each node's transform, including nested nodes, and flips triangle winding under
  mirroring transforms.
- Triangulates triangle strips and fans; skips point and line primitives and reports how many.
- Reads interleaved buffers, all index types, sparse accessors, and normalized integer positions.
- Merges vertices with identical positions, because glTF splits them at UV and normal seams.
- Ignores materials, textures, normals, cameras and animation; a DWG holds none of those.

Models using `KHR_draco_mesh_compression` or `EXT_meshopt_compression` are rejected with a
message asking for an uncompressed export, since decoding them needs another library.

Two defects turned up this way, both worked around in `native/glb2dwg.c` rather than in LibreDWG,
since they are about how the add API is used rather than bugs in it:

- **Entity links.** The add API leaves entities with `nolinks = 1` and no prev/next handles.
  AutoCAD writes both handles on every entity, null at the ends, and readers that expect that
  desynchronise and refuse the whole file. The chain is now rebuilt before encoding. Whether a
  file tripped this depended on how the bitstream landed, so small models could open while real
  ones failed — which is exactly why the checks above are worth running.
- **Layer linetypes.** `dwg_add_LAYER` does not set a linetype, leaving an empty linetype name.
  Each new layer now points at the standard CONTINUOUS linetype.

A test decodes the written file and checks every entity's links point at the right neighbour, so
the first of these cannot silently return.

## Patches to LibreDWG

Both are in `native/patches/` and are applied by the build. Both are worth sending upstream.

**0001, the handle reference index** (`src/dwg.c`). Its comparison function returned `1` for both
"greater" and "less", so the sorted index was never correct, and the first duplicate key disabled
it permanently in favour of a linear scan — making entity insertion quadratic. Refs are now
ordered by `(handle, code)`, so new refs append instead of shifting the array. Converting a
62,000-triangle model went from about 70 seconds to 1.6 seconds, with output byte-identical apart
from the creation timestamp.

**0002, a use-after-free in `dwg_add_POLYLINE_PFACE`** (`src/dwg_api.c`). The function holds a
`Dwg_Object *` across the loop that adds the mesh's vertices, but adding an object reallocs the
array that pointer refers to. Natively this segfaults on meshes above a few hundred vertices;
compiled to WebAssembly there is no crash, so the mesh was quietly written with wrong vertex
handles and came back with faces pointing at the wrong corners. The pointer is now looked up
again from its index after each addition. Without this patch, polyface output above roughly 500
vertices is silently wrong — 3D faces were never affected.

## Testing

`npm test` runs unit tests for the GLB reader, layer naming, vertex welding and mesh splitting,
and then a set of round-trip tests that answer the question that matters: is the DWG actually
right?

Those tests convert a model, hand the bytes back to LibreDWG's decoder, and pull out every
triangle, its layer, and the header values. The result is compared against the source geometry,
so nothing depends on the writer's own account of its work. They check that:

- every triangle survives with its coordinates and winding, under both entity types
- the geometry is three-dimensional, spanning what it should on all three axes
- each mesh lands on its own layer, and nodes keep their relative positions
- polyface and 3D face output describe exactly the same triangles
- units set `$INSUNITS` and scale the model, and Y-up becomes Z-up
- extents cover the geometry and ignore vertices no triangle uses
- a mesh too big for one polyface is split without losing or corrupting a triangle
- entities carry the prev/next links that AutoCAD-compatible readers expect

They skip themselves if the WebAssembly test module hasn't been built.

Beyond the suite, the Khronos models below were checked triangle by triangle against their source
GLB files, with no triangle in the DWG that wasn't in the model. Three further checks were run
outside the suite, since they need tools that can't be installed here from npm:

- **[ezdxf](https://ezdxf.mozman.at/)**, an unrelated parser, reads the output (converted to DXF
  with `dwg2dxf`) and agrees on entity types, counts, layer names, units and coordinates. Its
  `audit()` validator reports no errors and no fixes. For comparison, an AutoCAD-produced
  reference file put through the same conversion needs 230 fixes.
- **LibreDWG's own `dwgread -v3`** reports no errors. It prints a few "object handle not found"
  warnings, which are references resolved later in the file, plus `$HANDSEED`, the next-free-handle
  marker, which is meant to be one past the last handle. An AutoCAD reference file produces the
  same class of warnings.
- **`dwgrewrite`** decodes and re-encodes the file, and the geometry comes back intact.
- **A commercial DWG converter** (the one most CAD software licenses for DWG support) opens every
  output file with its audit enabled, across both entity types and model sizes up to 108,936
  triangles, and its own converted output keeps the geometry, layers and units intact.

Still untested: AutoCAD itself. Everything short of it agrees the files are sound.

Models from the [Khronos glTF sample assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
convert cleanly, and LibreDWG's own `dwgread` reads every output back without errors:

| Model | Triangles | Polyface | 3D faces |
| --- | --- | --- | --- |
| DamagedHelmet | 15,452 | 0.3 s, 1.0 MB | 0.2 s, 1.6 MB |
| SheenChair | 39,936 | 0.5 s, 2.5 MB | 0.2 s, 4.0 MB |
| BrainStem | 61,666 | 1.6 s, 3.9 MB | 0.8 s, 6.0 MB |
| ToyCar | 108,936 | 3.0 s, 12.1 MB | 0.8 s, 11.0 MB |

Not yet verified: opening the output in AutoCAD itself. If a drawing gives trouble there, try
the polyface option, or the other units.

## Licence

GPL-3.0-or-later. This page includes LibreDWG, which is GPL-3.0-or-later, so anything built from
it must be distributed under the same terms — including making the source available to people
who use the hosted page. Set `VITE_SOURCE_URL` at build time to add a source link to the page
footer:

```sh
VITE_SOURCE_URL=https://example.com/your/repo npm run build
```
