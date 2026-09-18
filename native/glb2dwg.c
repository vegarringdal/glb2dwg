// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * glb2dwg.c - the only C in this project.
 *
 * A small stateful wrapper over LibreDWG's add API. It is compiled to
 * WebAssembly together with LibreDWG. TypeScript parses the GLB and does all
 * geometry work; this file only turns ready-made arrays into DWG entities.
 *
 * Call order:
 *   g2d_begin()
 *   g2d_add_layer() / g2d_use_layer() / g2d_add_pface() / g2d_add_3dfaces()
 *   g2d_set_extents()
 *   g2d_finish()  ->  g2d_output_ptr() + g2d_output_len()
 *   g2d_end()
 *
 * Only one drawing can be open at a time.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <dwg.h>
#include <dwg_api.h>

#ifdef __EMSCRIPTEN__
#  include <emscripten/emscripten.h>
#  define G2D_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#  define G2D_EXPORT
#endif

/* JS writes xyz doubles and int16 face quads straight into WASM memory, and
   those bytes are handed to LibreDWG without copying. Layouts must match. */
_Static_assert (sizeof (dwg_point_3d) == 3 * sizeof (double),
                "dwg_point_3d must be three packed doubles");
_Static_assert (sizeof (dwg_face) == 4 * sizeof (int16_t),
                "dwg_face must be four int16 indices");

/* Polyface vertex indices are signed 16-bit and 1-based (negative = hidden
   edge), and the vertex/face counts are 16-bit too. */
#define G2D_PFACE_MAX 32767

/* LibreDWG only writes to files. /tmp exists in Emscripten's in-memory FS. */
#define G2D_OUT_PATH "/tmp/glb2dwg-output.dwg"

/* INSUNITS 6 = meters, which is what glTF uses. */
#define G2D_INSUNITS_METERS 6

static Dwg_Data *g_dwg = NULL;
static Dwg_Object_BLOCK_HEADER *g_mspace = NULL;
static BITCODE_RLL g_continuous = 0;
static BITCODE_H g_layer0 = NULL;
static BITCODE_H *g_layers = NULL;
static int g_num_layers = 0;
static unsigned char *g_out = NULL;
static uint32_t g_out_len = 0;

G2D_EXPORT void
g2d_end (void)
{
  if (g_dwg)
    {
      dwg_free (g_dwg);
      free (g_dwg);
    }
  free (g_layers);
  free (g_out);
  g_dwg = NULL;
  g_mspace = NULL;
  g_continuous = 0;
  g_layer0 = NULL;
  g_layers = NULL;
  g_num_layers = 0;
  g_out = NULL;
  g_out_len = 0;
}

/* Starts a new, empty R2000 drawing in meters. Returns 0 on success. */
G2D_EXPORT int
g2d_begin (void)
{
  g2d_end ();

  /* R2000 is the newest DWG version LibreDWG can write. */
  g_dwg = dwg_new_Document (R_2000, 0 /* metric */, 0 /* no logging */);
  if (!g_dwg)
    return -1;

  Dwg_Object *mspace = dwg_model_space_object (g_dwg);
  if (!mspace || !mspace->tio.object)
    {
      g2d_end ();
      return -1;
    }
  g_mspace = mspace->tio.object->tio.BLOCK_HEADER;
  g_layer0 = g_dwg->header_vars.CLAYER;
  g_dwg->header_vars.INSUNITS = G2D_INSUNITS_METERS;

  /* dwg_add_LAYER leaves the linetype unset, which shows up as an empty
     linetype name in the file. Remember the standard CONTINUOUS linetype so
     layers can point at it. */
  g_continuous = 0;
  for (BITCODE_BL i = 0; i < g_dwg->num_objects; i++)
    {
      Dwg_Object *entry = &g_dwg->object[i];
      if (entry->fixedtype == DWG_TYPE_LTYPE && entry->tio.object
          && entry->tio.object->tio.LTYPE->name
          && strcmp (entry->tio.object->tio.LTYPE->name, "CONTINUOUS") == 0)
        {
          g_continuous = entry->handle.value;
          break;
        }
    }
  return 0;
}

/* Sets the drawing units: a DWG $INSUNITS code (4 = mm, 5 = cm, 6 = m,
   1 = inches, 2 = feet). Coordinates are scaled by the caller.
   $MEASUREMENT lives in a section LibreDWG does not write for R2000, so it is
   left alone. */
G2D_EXPORT void
g2d_set_units (int insunits)
{
  if (!g_dwg)
    return;
  g_dwg->header_vars.INSUNITS = (BITCODE_BS)insunits;
}

/* Adds a layer and returns its index, or -1. Names must be unique (the caller
   dedupes). color is an AutoCAD Color Index 1-255; anything else keeps the
   default. */
G2D_EXPORT int
g2d_add_layer (const char *name, int color)
{
  if (!g_dwg || !name || !*name)
    return -1;

  Dwg_Object_LAYER *layer = dwg_add_LAYER (g_dwg, name);
  if (!layer)
    return -1;
  if (color >= 1 && color <= 255)
    layer->color.index = (BITCODE_BSd)color;
  if (g_continuous)
    layer->ltype = dwg_add_handleref (g_dwg, 5, g_continuous, NULL);

  int error = 0;
  Dwg_Object *obj = dwg_obj_generic_to_object (layer, &error);
  if (error || !obj)
    return -1;

  BITCODE_H *grown
      = (BITCODE_H *)realloc (g_layers, (size_t)(g_num_layers + 1) * sizeof (BITCODE_H));
  if (!grown)
    return -1;
  g_layers = grown;
  g_layers[g_num_layers] = dwg_add_handleref (g_dwg, 5, obj->handle.value, NULL);
  return g_num_layers++;
}

/* Entities added afterwards land on this layer. -1 selects layer "0".
   LibreDWG assigns CLAYER to every new entity, including the VERTEX and
   SEQEND sub-entities of a polyface mesh. */
G2D_EXPORT int
g2d_use_layer (int index)
{
  if (!g_dwg || index < -1 || index >= g_num_layers)
    return -1;
  g_dwg->header_vars.CLAYER = index < 0 ? g_layer0 : g_layers[index];
  return 0;
}

/* Adds one polyface mesh.
   xyz:   num_verts * 3 doubles.
   faces: num_faces * 4 int16, 1-based vertex indices; 4th = 0 for triangles.
   Returns 0 on success. */
G2D_EXPORT int
g2d_add_pface (const double *xyz, uint32_t num_verts, const int16_t *faces,
               uint32_t num_faces)
{
  if (!g_mspace || !xyz || !faces || num_verts < 3 || num_faces < 1
      || num_verts > G2D_PFACE_MAX || num_faces > G2D_PFACE_MAX)
    return -1;

  Dwg_Entity_POLYLINE_PFACE *pface = dwg_add_POLYLINE_PFACE (
      g_mspace, num_verts, num_faces, (const dwg_point_3d *)xyz,
      (const dwg_face *)faces);
  return pface ? 0 : -1;
}

/* Adds one 3DFACE per triangle. xyz: num_tris * 9 doubles (three corners per
   triangle). Returns 0 on success. */
G2D_EXPORT int
g2d_add_3dfaces (const double *xyz, uint32_t num_tris)
{
  if (!g_mspace || !xyz)
    return -1;

  const dwg_point_3d *pts = (const dwg_point_3d *)xyz;
  for (uint32_t i = 0; i < num_tris; i++)
    {
      const dwg_point_3d *p = &pts[(size_t)i * 3];
      if (!dwg_add_3DFACE (g_mspace, &p[0], &p[1], &p[2], NULL))
        return -1;
    }
  return 0;
}

/* Drawing extents, so CAD viewers open zoomed to the model. */
G2D_EXPORT void
g2d_set_extents (double min_x, double min_y, double min_z, double max_x,
                 double max_y, double max_z)
{
  if (!g_dwg)
    return;
  g_dwg->header_vars.EXTMIN.x = min_x;
  g_dwg->header_vars.EXTMIN.y = min_y;
  g_dwg->header_vars.EXTMIN.z = min_z;
  g_dwg->header_vars.EXTMAX.x = max_x;
  g_dwg->header_vars.EXTMAX.y = max_y;
  g_dwg->header_vars.EXTMAX.z = max_z;
}

/* Rebuilds the model space entity chain the way AutoCAD writes it: every
   entity carries prev and next handles, null at the ends, with nolinks = 0.
   LibreDWG's add API leaves nolinks = 1 and no handles on some entities.
   AutoCAD-compatible readers desynchronise on that and refuse to open the
   file, reporting that a dictionary cannot be read as an entity, so the chain
   has to be rebuilt before encoding.
   Vertices and SEQENDs are owned by their polyline, not by the block, so they
   are left alone. */
static int
fix_entity_chain (void)
{
  BITCODE_BL *ents = (BITCODE_BL *)malloc (sizeof (BITCODE_BL) * g_dwg->num_objects);
  if (!ents)
    return -1;

  BITCODE_BL count = 0;
  for (BITCODE_BL i = 0; i < g_dwg->num_objects; i++)
    {
      Dwg_Object *obj = &g_dwg->object[i];
      if (obj->supertype == DWG_SUPERTYPE_ENTITY
          && (obj->fixedtype == DWG_TYPE__3DFACE
              || obj->fixedtype == DWG_TYPE_POLYLINE_PFACE))
        ents[count++] = i;
    }

  for (BITCODE_BL k = 0; k < count; k++)
    {
      Dwg_Object_Entity *entity = g_dwg->object[ents[k]].tio.entity;
      BITCODE_RLL prev = k > 0 ? g_dwg->object[ents[k - 1]].handle.value : 0;
      BITCODE_RLL next = k + 1 < count ? g_dwg->object[ents[k + 1]].handle.value : 0;
      entity->nolinks = 0;
      entity->prev_entity = dwg_add_handleref (g_dwg, 4, prev, NULL);
      entity->next_entity = dwg_add_handleref (g_dwg, 4, next, NULL);
    }

  free (ents);
  return 0;
}

/* Encodes the drawing. Returns 0 on success, -1 on I/O or memory failure, or
   LibreDWG's critical error bits (> 0). */
G2D_EXPORT int
g2d_finish (void)
{
  if (!g_dwg)
    return -1;

  free (g_out);
  g_out = NULL;
  g_out_len = 0;

  /* Leave layer "0" current, as a CAD user would expect. */
  g_dwg->header_vars.CLAYER = g_layer0;

  if (fix_entity_chain () != 0)
    return -1;

  /* dwg_write_file refuses to overwrite an existing file. */
  remove (G2D_OUT_PATH);
  int error = dwg_write_file (G2D_OUT_PATH, g_dwg);
  if (error >= DWG_ERR_CRITICAL)
    {
      remove (G2D_OUT_PATH);
      return error;
    }

  FILE *fh = fopen (G2D_OUT_PATH, "rb");
  if (!fh)
    return -1;

  int result = -1;
  if (fseek (fh, 0, SEEK_END) == 0)
    {
      long size = ftell (fh);
      if (size > 0 && (unsigned long)size <= UINT32_MAX && fseek (fh, 0, SEEK_SET) == 0)
        {
          g_out = (unsigned char *)malloc ((size_t)size);
          if (g_out && fread (g_out, 1, (size_t)size, fh) == (size_t)size)
            {
              g_out_len = (uint32_t)size;
              result = 0;
            }
          else
            {
              free (g_out);
              g_out = NULL;
            }
        }
    }
  fclose (fh);
  remove (G2D_OUT_PATH);
  return result;
}

G2D_EXPORT unsigned char *
g2d_output_ptr (void)
{
  return g_out;
}

G2D_EXPORT uint32_t
g2d_output_len (void)
{
  return g_out_len;
}

/* ---------------------------------------------------------------------------
 * Reader, compiled only with -DG2D_WITH_READER (see native/build.sh).
 *
 * This exists so the test suite can check what actually landed in the file:
 * the DWG bytes are handed back to LibreDWG's decoder, and every triangle,
 * its layer, and the header values are read out for comparison against the
 * source model. It is not part of the app build.
 * ------------------------------------------------------------------------ */
#ifdef G2D_WITH_READER

#  define G2D_IN_PATH "/tmp/glb2dwg-input.dwg"

static Dwg_Data *g_in = NULL;
static double *g_tris = NULL;   /* 9 doubles per triangle */
static int32_t *g_tri_layer = NULL;
static uint32_t g_num_tris = 0;
static uint32_t g_cap_tris = 0;
static char **g_layer_names = NULL;
static uint32_t g_num_layer_names = 0;

static int32_t
layer_index_of (const Dwg_Object *obj)
{
  if (!obj || obj->supertype != DWG_SUPERTYPE_ENTITY || !obj->tio.entity)
    return -1;
  Dwg_Object *layer = dwg_ref_object (g_in, obj->tio.entity->layer);
  if (!layer || layer->fixedtype != DWG_TYPE_LAYER)
    return -1;
  const char *name = layer->tio.object->tio.LAYER->name;
  if (!name)
    return -1;
  for (uint32_t i = 0; i < g_num_layer_names; i++)
    if (g_layer_names[i] && strcmp (g_layer_names[i], name) == 0)
      return (int32_t)i;
  return -1;
}

static int
push_triangle (const double *a, const double *b, const double *c, int32_t layer)
{
  if (g_num_tris == g_cap_tris)
    {
      uint32_t cap = g_cap_tris ? g_cap_tris * 2 : 1024;
      double *tris = (double *)realloc (g_tris, (size_t)cap * 9 * sizeof (double));
      int32_t *layers = (int32_t *)realloc (g_tri_layer, (size_t)cap * sizeof (int32_t));
      if (tris)
        g_tris = tris;
      if (layers)
        g_tri_layer = layers;
      if (!tris || !layers)
        return -1;
      g_cap_tris = cap;
    }
  double *out = &g_tris[(size_t)g_num_tris * 9];
  memcpy (out, a, 3 * sizeof (double));
  memcpy (out + 3, b, 3 * sizeof (double));
  memcpy (out + 6, c, 3 * sizeof (double));
  g_tri_layer[g_num_tris++] = layer;
  return 0;
}

/* Collects every triangle in the drawing, in file order. Polyface meshes are
   walked through the object list: their vertices and faces follow them, up to
   the SEQEND. */
static int
collect_triangles (void)
{
  double *verts = NULL;
  uint32_t num_verts = 0, cap_verts = 0;
  int32_t pface_layer = -1;
  int in_pface = 0;
  int error = 0;

  for (BITCODE_BL i = 0; i < g_in->num_objects && !error; i++)
    {
      Dwg_Object *obj = &g_in->object[i];
      if (obj->supertype != DWG_SUPERTYPE_ENTITY || !obj->tio.entity)
        continue;

      switch (obj->fixedtype)
        {
        case DWG_TYPE__3DFACE:
          {
            Dwg_Entity__3DFACE *face = obj->tio.entity->tio._3DFACE;
            error = push_triangle (&face->corner1.x, &face->corner2.x, &face->corner3.x,
                                   layer_index_of (obj));
            break;
          }

        case DWG_TYPE_POLYLINE_PFACE:
          in_pface = 1;
          num_verts = 0;
          pface_layer = layer_index_of (obj);
          break;

        case DWG_TYPE_VERTEX_PFACE:
          {
            if (!in_pface)
              break;
            if (num_verts == cap_verts)
              {
                uint32_t cap = cap_verts ? cap_verts * 2 : 1024;
                double *grown = (double *)realloc (verts, (size_t)cap * 3 * sizeof (double));
                if (!grown)
                  {
                    error = -1;
                    break;
                  }
                verts = grown;
                cap_verts = cap;
              }
            Dwg_Entity_VERTEX_PFACE *vertex = obj->tio.entity->tio.VERTEX_PFACE;
            memcpy (&verts[(size_t)num_verts++ * 3], &vertex->point.x, 3 * sizeof (double));
            break;
          }

        case DWG_TYPE_VERTEX_PFACE_FACE:
          {
            if (!in_pface)
              break;
            Dwg_Entity_VERTEX_PFACE_FACE *face = obj->tio.entity->tio.VERTEX_PFACE_FACE;
            /* Indices are 1-based; negative marks an invisible edge. */
            int32_t idx[4];
            int corners = 0;
            for (int k = 0; k < 4; k++)
              {
                int32_t v = face->vertind[k] < 0 ? -face->vertind[k] : face->vertind[k];
                if (v == 0)
                  break;
                if ((uint32_t)v > num_verts)
                  {
                    error = -1;
                    break;
                  }
                idx[corners++] = v - 1;
              }
            if (error)
              break;
            if (corners >= 3)
              error = push_triangle (&verts[(size_t)idx[0] * 3], &verts[(size_t)idx[1] * 3],
                                     &verts[(size_t)idx[2] * 3], pface_layer);
            /* A quad face is two triangles. */
            if (!error && corners == 4)
              error = push_triangle (&verts[(size_t)idx[0] * 3], &verts[(size_t)idx[2] * 3],
                                     &verts[(size_t)idx[3] * 3], pface_layer);
            break;
          }

        case DWG_TYPE_SEQEND:
          in_pface = 0;
          break;

        default:
          break;
        }
    }

  free (verts);
  return error;
}

static int
collect_layers (void)
{
  for (BITCODE_BL i = 0; i < g_in->num_objects; i++)
    {
      Dwg_Object *obj = &g_in->object[i];
      if (obj->fixedtype != DWG_TYPE_LAYER || !obj->tio.object)
        continue;
      char **grown = (char **)realloc (g_layer_names,
                                       (size_t)(g_num_layer_names + 1) * sizeof (char *));
      if (!grown)
        return -1;
      g_layer_names = grown;
      g_layer_names[g_num_layer_names++] = obj->tio.object->tio.LAYER->name;
    }
  return 0;
}

G2D_EXPORT void
g2d_read_close (void)
{
  if (g_in)
    {
      dwg_free (g_in);
      free (g_in);
    }
  free (g_tris);
  free (g_tri_layer);
  free (g_layer_names);
  g_in = NULL;
  g_tris = NULL;
  g_tri_layer = NULL;
  g_layer_names = NULL;
  g_num_tris = g_cap_tris = g_num_layer_names = 0;
}

/* Decodes a DWG from memory and extracts its triangles. Returns 0 on success. */
G2D_EXPORT int
g2d_read_open (const unsigned char *data, uint32_t len)
{
  g2d_read_close ();
  if (!data || len == 0)
    return -1;

  FILE *fh = fopen (G2D_IN_PATH, "wb");
  if (!fh)
    return -1;
  size_t written = fwrite (data, 1, len, fh);
  fclose (fh);
  if (written != len)
    return -1;

  g_in = (Dwg_Data *)calloc (1, sizeof (Dwg_Data));
  if (!g_in)
    return -1;

  int error = dwg_read_file (G2D_IN_PATH, g_in);
  remove (G2D_IN_PATH);
  if (error >= DWG_ERR_CRITICAL)
    {
      g2d_read_close ();
      return error;
    }
  if (collect_layers () || collect_triangles ())
    {
      g2d_read_close ();
      return -1;
    }
  return 0;
}

/* Counts model space entities whose prev/next links are missing or point at
   the wrong neighbour. Should be zero; see fix_entity_chain above. */
G2D_EXPORT int
g2d_read_chain_errors (void)
{
  if (!g_in)
    return -1;

  BITCODE_BL *ents = (BITCODE_BL *)malloc (sizeof (BITCODE_BL) * g_in->num_objects);
  if (!ents)
    return -1;

  BITCODE_BL count = 0;
  for (BITCODE_BL i = 0; i < g_in->num_objects; i++)
    {
      Dwg_Object *obj = &g_in->object[i];
      if (obj->supertype == DWG_SUPERTYPE_ENTITY
          && (obj->fixedtype == DWG_TYPE__3DFACE
              || obj->fixedtype == DWG_TYPE_POLYLINE_PFACE))
        ents[count++] = i;
    }

  int errors = 0;
  for (BITCODE_BL k = 0; k < count; k++)
    {
      Dwg_Object *obj = &g_in->object[ents[k]];
      Dwg_Object_Entity *entity = obj->tio.entity;
      BITCODE_RLL prev = k > 0 ? g_in->object[ents[k - 1]].handle.value : 0;
      BITCODE_RLL next = k + 1 < count ? g_in->object[ents[k + 1]].handle.value : 0;
      if (entity->nolinks || !entity->prev_entity || !entity->next_entity
          || entity->prev_entity->absolute_ref != prev
          || entity->next_entity->absolute_ref != next)
        errors++;
    }

  free (ents);
  return errors;
}

G2D_EXPORT int
g2d_read_version (void)
{
  return g_in ? (int)g_in->header.version : -1;
}

G2D_EXPORT int
g2d_read_insunits (void)
{
  return g_in ? (int)g_in->header_vars.INSUNITS : -1;
}

/* Writes EXTMIN xyz then EXTMAX xyz. */
G2D_EXPORT void
g2d_read_extents (double *out6)
{
  if (!g_in || !out6)
    return;
  out6[0] = g_in->header_vars.EXTMIN.x;
  out6[1] = g_in->header_vars.EXTMIN.y;
  out6[2] = g_in->header_vars.EXTMIN.z;
  out6[3] = g_in->header_vars.EXTMAX.x;
  out6[4] = g_in->header_vars.EXTMAX.y;
  out6[5] = g_in->header_vars.EXTMAX.z;
}

G2D_EXPORT uint32_t
g2d_read_num_triangles (void)
{
  return g_num_tris;
}

/* Copies up to max_tris triangles (9 doubles each) and their layer indices. */
G2D_EXPORT uint32_t
g2d_read_triangles (double *out_xyz, int32_t *out_layer, uint32_t max_tris)
{
  uint32_t count = g_num_tris < max_tris ? g_num_tris : max_tris;
  if (out_xyz)
    memcpy (out_xyz, g_tris, (size_t)count * 9 * sizeof (double));
  if (out_layer)
    memcpy (out_layer, g_tri_layer, (size_t)count * sizeof (int32_t));
  return count;
}

G2D_EXPORT uint32_t
g2d_read_num_layers (void)
{
  return g_num_layer_names;
}

/* Copies layer name `index` into buf as NUL-terminated UTF-8. */
G2D_EXPORT uint32_t
g2d_read_layer_name (uint32_t index, char *buf, uint32_t buflen)
{
  if (index >= g_num_layer_names || !buf || buflen == 0)
    return 0;
  const char *name = g_layer_names[index] ? g_layer_names[index] : "";
  uint32_t len = (uint32_t)strlen (name);
  if (len >= buflen)
    len = buflen - 1;
  memcpy (buf, name, len);
  buf[len] = 0;
  return len;
}

#endif /* G2D_WITH_READER */
