#!/usr/bin/env bash
# Builds LibreDWG and native/glb2dwg.c into src/wasm/glb2dwg.{mjs,wasm}.
#
# Needs Emscripten (emcc, emconfigure, emmake) on PATH, plus curl, tar, make.
# Re-running is cheap: download, configure and compile steps are skipped when
# their output already exists. Delete native/build/ to start over.
set -euo pipefail

LIBREDWG_VERSION="0.13.4"
LIBREDWG_SHA256="7e153ea4dac4cbf3dc9c50b9ef7a5604e09cdd4c5520bcf8017877bbe1422cd5"
LIBREDWG_URL="https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.xz"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/native/build"
TARBALL="$BUILD_DIR/libredwg-${LIBREDWG_VERSION}.tar.xz"
SRC_DIR="$BUILD_DIR/libredwg-${LIBREDWG_VERSION}"
LIB="$SRC_DIR/src/.libs/libredwg.a"

# Overridable for testing, e.g. G2D_ENVIRONMENT=node G2D_OUT=/tmp/g2d.mjs
ENVIRONMENT="${G2D_ENVIRONMENT:-web,worker}"
OUT="${G2D_OUT:-$ROOT/src/wasm/glb2dwg.mjs}"

log() { printf '\n[build:wasm] %s\n' "$*"; }

for tool in emcc emconfigure emmake curl tar make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing '$tool'." >&2
    if [[ "$tool" == em* ]]; then
      echo "Install and activate the Emscripten SDK (https://emscripten.org/docs/getting_started/downloads.html)," >&2
      echo "or run 'npm run build:wasm:docker' instead." >&2
    fi
    exit 1
  fi
done

jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
mkdir -p "$BUILD_DIR" "$(dirname "$OUT")"

if [[ ! -f "$TARBALL" ]]; then
  log "Downloading LibreDWG ${LIBREDWG_VERSION}"
  curl -fL --retry 3 -o "$TARBALL.part" "$LIBREDWG_URL"
  mv "$TARBALL.part" "$TARBALL"
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
fi
if [[ "$actual" != "$LIBREDWG_SHA256" ]]; then
  echo "Checksum mismatch for $TARBALL (got $actual). Delete it and retry." >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR" ]]; then
  log "Extracting"
  # tar keeps file timestamps, which stops make from trying to rerun automake.
  tar -xf "$TARBALL" -C "$BUILD_DIR"
fi

# Patches for LibreDWG itself; see the header of each file for why.
for patch_file in "$ROOT"/native/patches/*.patch; do
  [[ -e "$patch_file" ]] || continue
  stamp="$SRC_DIR/.applied-$(basename "$patch_file")"
  [[ -f "$stamp" ]] && continue
  log "Applying $(basename "$patch_file")"
  if command -v patch >/dev/null 2>&1; then
    patch -d "$SRC_DIR" -p1 --forward < "$patch_file"
  else
    (cd "$SRC_DIR" && git apply -p1 "$patch_file")
  fi
  touch "$stamp"
done

if [[ ! -f "$SRC_DIR/config.status" ]]; then
  log "Configuring LibreDWG for WebAssembly"
  (
    cd "$SRC_DIR"
    emconfigure ./configure \
      --host=wasm32-unknown-emscripten \
      --disable-shared --enable-static \
      --disable-bindings --disable-python --disable-docs \
      --disable-dxf --disable-json \
      --disable-werror --enable-release \
      CFLAGS="-O2"
  )
fi

log "Compiling LibreDWG (the first build takes a few minutes)"
emmake make -C "$SRC_DIR/src" -j"$jobs" libredwg.la

writer_exports="_malloc,_free,_g2d_begin,_g2d_end,_g2d_add_layer,_g2d_use_layer,_g2d_set_units,_g2d_add_pface,_g2d_add_3dfaces,_g2d_set_extents,_g2d_finish,_g2d_output_ptr,_g2d_output_len"
reader_exports="_g2d_read_open,_g2d_read_close,_g2d_read_chain_errors,_g2d_read_version,_g2d_read_insunits,_g2d_read_extents,_g2d_read_num_triangles,_g2d_read_triangles,_g2d_read_num_layers,_g2d_read_layer_name"

# $1 output path, $2 exported functions, $3... extra emcc flags
link_module () {
  local out="$1" exports="$2"
  shift 2
  mkdir -p "$(dirname "$out")"
  emcc -O2 \
    -I"$SRC_DIR/include" \
    "$ROOT/native/glb2dwg.c" "$LIB" \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createGlb2DwgModule \
    -sENVIRONMENT="$ENVIRONMENT" \
    -sALLOW_MEMORY_GROWTH=1 \
    -sMAXIMUM_MEMORY=4GB \
    -sEXPORTED_FUNCTIONS="$exports" \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    "$@" \
    -o "$out"
  log "Built $out ($(du -h "${out%.mjs}.wasm" | cut -f1) wasm)"
}

log "Linking $OUT"
link_module "$OUT" "$writer_exports"

# A second module with LibreDWG's decoder as well, so the tests can read back
# what was written. Not shipped with the app; skip with G2D_SKIP_TEST_MODULE=1.
if [[ "${G2D_SKIP_TEST_MODULE:-0}" != "1" ]]; then
  log "Linking the test module (adds LibreDWG's reader)"
  link_module "${G2D_TEST_OUT:-$ROOT/test/wasm/glb2dwg-test.mjs}" \
    "$writer_exports,$reader_exports" -DG2D_WITH_READER
fi
