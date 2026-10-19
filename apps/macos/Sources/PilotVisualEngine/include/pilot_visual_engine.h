#ifndef PILOT_VISUAL_ENGINE_H
#define PILOT_VISUAL_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// One QuickJS-NG runtime and context for one live visual. Not thread-safe: call it from one serial executor.
typedef struct PVEngine PVEngine;

/// A result message in the visual wire encoding (see VisualWire.swift). Free with pv_buffer_free.
typedef struct PVBuffer {
    uint8_t *bytes;
    size_t length;
} PVBuffer;

/// Heap and JavaScript stack limits in bytes, and the time limit of each phase in milliseconds.
typedef struct PVLimits {
    size_t heap_bytes;
    size_t stack_bytes;
    uint32_t setup_ms;
    uint32_t view_ms;
    uint32_t handler_ms;
    uint32_t draw_ms;
} PVLimits;

/// Creates an engine. Returns NULL on allocation failure.
PVEngine *pv_engine_create(PVLimits limits);
void pv_engine_free(PVEngine *engine);

/// The vendored QuickJS-NG version, for example "0.17.0".
const char *pv_engine_version(void);

/// Evaluates the shared visual runtime (runtime.js), compiles the visual function, runs setup through the runtime's
/// load, then its first view. state_json may be NULL for a fresh visual. The runtime seeds Math.random from seed,
/// the artifact id, and now is Date.now. Strings are UTF-8 and need no terminator. Returns 0 when the visual rendered,
/// 1 when the result describes an error; *result always receives a reply envelope.
int pv_engine_load(PVEngine *engine,
                   const char *runtime, size_t runtime_length,
                   const char *source, size_t source_length,
                   const char *data_json, size_t data_length,
                   const char *state_json, size_t state_length,
                   const char *seed, size_t seed_length,
                   double now, PVBuffer *result);

/// Runs the handler of control id with one JSON value (NULL for none), then the view, on a loaded engine.
int pv_engine_event(PVEngine *engine,
                    const char *id, size_t id_length,
                    const char *value_json, size_t value_length,
                    double now, PVBuffer *result);

/// Runs the draw function of canvas id (from the last tree) for a width x height area at t seconds, with the pointer
/// when has_pointer. On success returns 0 and writes the drawing ("PD" encoding, see pilot_visual_engine.c) into
/// out when it fits in capacity, setting *written, else into *result. On failure returns 1 with an error envelope in
/// *result.
int pv_engine_draw(PVEngine *engine,
                   const char *id, size_t id_length,
                   double width, double height, double t,
                   int has_pointer, double pointer_x, double pointer_y,
                   uint8_t *out, size_t capacity, size_t *written,
                   PVBuffer *result);

/// Bytes the engine's heap currently holds.
size_t pv_engine_memory_used(PVEngine *engine);

void pv_buffer_free(PVBuffer *buffer);

#ifdef __cplusplus
}
#endif

#endif
