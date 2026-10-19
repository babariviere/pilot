// The visual engine: one QuickJS-NG runtime per live visual, driving the shared visual runtime (runtime.js) under
// Pilot's limits exactly as the kernel's pre-check does (packages/protocol/fixtures/visual/README.md, "Host
// contract"), and a compact binary encoding of its results. It runs only inside the sandboxed PilotVisuals service.
//
// Wire encoding (mirrored by VisualWire.swift). A message starts with "PV" and version 1, then one value:
//   0 null, 1 false, 2 true, 3 integer (zigzag varint), 4 float64 (little endian), 5 string, 6 array
//   (varint count, then values), 7 object (varint count, then string key and value pairs).
// A string, as a value or a key, is a varint n. Odd n is a literal of n >> 1 UTF-8 bytes; literals of at most
// 64 bytes join an intern table (up to 4096 entries) in order of appearance. Even n refers to entry n >> 1.
// Values follow JSON.stringify: toJSON is applied, undefined, functions and symbols are skipped in objects and
// become null in arrays, and non-finite numbers become null.
//
// Drawings (mirrored by VisualDrawing.swift) start with "PD", version 1 and a zero byte, then five little-endian
// uint32: commands, op count, string count, string bytes and zero; then the ops as float64 (8-byte aligned at
// offset 24), then each string as a uint32 byte count and its UTF-8 bytes. The ops follow DRAW_FORMAT in runtime.js.

#include "pilot_visual_engine.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "quickjs.h"

enum {
    PV_NULL = 0,
    PV_FALSE = 1,
    PV_TRUE = 2,
    PV_INTEGER = 3,
    PV_FLOAT = 4,
    PV_STRING = 5,
    PV_ARRAY = 6,
    PV_OBJECT = 7,
};

#define PV_MAX_OUTPUT (16u << 20)
#define PV_MAX_DEPTH 64
#define PV_INTERN_LIMIT 4096u
#define PV_INTERN_MAX_LENGTH 64u
#define PV_INTERN_SLOTS 8192u
#define PV_MAX_MESSAGE 1024u
#define PV_MAX_STACK_TEXT 4096u
#define PV_SOURCE_NAME "visual.js"
#define PV_SOURCE_PREFIX "\"use strict\";("
#define PV_RUNTIME_NAME "pilot-visual-runtime.js"

typedef enum PVPhase { PV_PHASE_NONE, PV_PHASE_SETUP, PV_PHASE_VIEW, PV_PHASE_HANDLER, PV_PHASE_DRAW } PVPhase;

#define PV_DRAWING_HEADER 24u
#define PV_MAX_DRAWING (64u << 20)

struct PVEngine {
    JSRuntime *runtime;
    JSContext *context;
    PVLimits limits;
    /// The runtime's API object and its functions.
    JSValue api;
    JSValue load;
    JSValue render;
    JSValue event;
    JSValue state;
    JSValue logs;
    JSValue draw;
    JSValue frame;
    bool loaded;
    bool ready;
    uint64_t deadline;
    PVPhase phase;
    bool timed_out;
};

typedef struct PVInterned {
    const uint8_t *text;
    uint32_t length;
    uint32_t hash;
    uint32_t index;
    bool used;
} PVInterned;

typedef struct PVWriter {
    uint8_t *bytes;
    size_t length;
    size_t capacity;
    PVInterned *slots;
    uint32_t interned;
    const char *error;
} PVWriter;

// MARK: - Writer

static uint64_t pv_now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static bool pv_reserve(PVWriter *w, size_t extra) {
    if (w->error) return false;
    if (w->length + extra > PV_MAX_OUTPUT) {
        w->error = "The visual's tree is larger than 16 MiB.";
        return false;
    }
    if (w->length + extra <= w->capacity) return true;
    size_t capacity = w->capacity ? w->capacity : 1024;
    while (capacity < w->length + extra) capacity *= 2;
    uint8_t *bytes = realloc(w->bytes, capacity);
    if (!bytes) {
        w->error = "Out of memory while encoding the visual.";
        return false;
    }
    w->bytes = bytes;
    w->capacity = capacity;
    return true;
}

static bool pv_byte(PVWriter *w, uint8_t byte) {
    if (!pv_reserve(w, 1)) return false;
    w->bytes[w->length++] = byte;
    return true;
}

static bool pv_varint(PVWriter *w, uint64_t value) {
    if (!pv_reserve(w, 10)) return false;
    do {
        uint8_t byte = value & 0x7f;
        value >>= 7;
        if (value) byte |= 0x80;
        w->bytes[w->length++] = byte;
    } while (value);
    return true;
}

static uint32_t pv_hash(const uint8_t *text, size_t length) {
    uint32_t hash = 2166136261u;
    for (size_t i = 0; i < length; i++) hash = (hash ^ text[i]) * 16777619u;
    return hash;
}

static bool pv_string(PVWriter *w, const char *text, size_t length) {
    const uint8_t *bytes = (const uint8_t *)text;
    PVInterned *slot = NULL;
    uint32_t hash = 0;
    if (length <= PV_INTERN_MAX_LENGTH) {
        if (!w->slots) {
            w->slots = calloc(PV_INTERN_SLOTS, sizeof(PVInterned));
            if (!w->slots) {
                w->error = "Out of memory while encoding the visual.";
                return false;
            }
        }
        hash = pv_hash(bytes, length);
        for (uint32_t probe = 0; probe < PV_INTERN_SLOTS; probe++) {
            PVInterned *candidate = &w->slots[(hash + probe) & (PV_INTERN_SLOTS - 1)];
            if (!candidate->used) {
                slot = candidate;
                break;
            }
            if (candidate->hash == hash && candidate->length == length &&
                memcmp(candidate->text, bytes, length) == 0) {
                return pv_varint(w, (uint64_t)candidate->index << 1);
            }
        }
    }
    if (!pv_varint(w, ((uint64_t)length << 1) | 1) || !pv_reserve(w, length)) return false;
    memcpy(w->bytes + w->length, bytes, length);
    w->length += length;
    if (slot && w->interned < PV_INTERN_LIMIT) {
        uint8_t *copy = malloc(length ? length : 1);
        if (!copy) {
            w->error = "Out of memory while encoding the visual.";
            return false;
        }
        memcpy(copy, bytes, length);
        *slot = (PVInterned){ .text = copy, .length = (uint32_t)length, .hash = hash, .index = w->interned++,
                              .used = true };
    }
    return true;
}

static bool pv_cstring(PVWriter *w, const char *text) { return pv_byte(w, PV_STRING) && pv_string(w, text, strlen(text)); }

static bool pv_key(PVWriter *w, const char *key) { return pv_string(w, key, strlen(key)); }

static bool pv_number(PVWriter *w, double value) {
    if (!isfinite(value)) return pv_byte(w, PV_NULL);
    if (value == trunc(value) && fabs(value) <= 9007199254740992.0) {
        int64_t integer = (int64_t)value;
        return pv_byte(w, PV_INTEGER) && pv_varint(w, ((uint64_t)integer << 1) ^ (uint64_t)(integer >> 63));
    }
    if (!pv_byte(w, PV_FLOAT) || !pv_reserve(w, 8)) return false;
    uint64_t bits;
    memcpy(&bits, &value, 8);
    for (int i = 0; i < 8; i++) w->bytes[w->length++] = (uint8_t)(bits >> (8 * i));
    return true;
}

static void pv_writer_free(PVWriter *w) {
    if (w->slots) {
        for (uint32_t i = 0; i < PV_INTERN_SLOTS; i++) {
            if (w->slots[i].used) free((void *)w->slots[i].text);
        }
        free(w->slots);
    }
    free(w->bytes);
    *w = (PVWriter){ 0 };
}

static bool pv_header(PVWriter *w) { return pv_byte(w, 'P') && pv_byte(w, 'V') && pv_byte(w, 1); }

// MARK: - JavaScript values

enum { PV_WRITE_OK = 0, PV_WRITE_EXCEPTION = -1, PV_WRITE_FAILED = -2 };

/// Applies toJSON like JSON.stringify. Takes ownership of value.
static JSValue pv_resolve(JSContext *ctx, JSValue value, JSValueConst key) {
    if (!JS_IsObject(value)) return value;
    JSValue method = JS_GetPropertyStr(ctx, value, "toJSON");
    if (JS_IsException(method)) {
        JS_FreeValue(ctx, value);
        return JS_EXCEPTION;
    }
    if (!JS_IsFunction(ctx, method)) {
        JS_FreeValue(ctx, method);
        return value;
    }
    JSValue replaced = JS_Call(ctx, method, value, 1, &key);
    JS_FreeValue(ctx, method);
    JS_FreeValue(ctx, value);
    return replaced;
}

static bool pv_skipped(JSContext *ctx, JSValueConst value) {
    return JS_IsUndefined(value) || JS_IsSymbol(value) || JS_IsFunction(ctx, value);
}

static int pv_write(PVWriter *w, JSContext *ctx, JSValueConst value, int depth);

static int pv_write_array(PVWriter *w, JSContext *ctx, JSValueConst array, int depth) {
    int64_t length;
    if (JS_GetLength(ctx, array, &length) < 0) return PV_WRITE_EXCEPTION;
    if (!pv_byte(w, PV_ARRAY) || !pv_varint(w, (uint64_t)length)) return PV_WRITE_FAILED;
    for (int64_t index = 0; index < length; index++) {
        JSValue key = JS_NewInt64(ctx, index);
        JSValue element = pv_resolve(ctx, JS_GetPropertyInt64(ctx, array, index), key);
        JS_FreeValue(ctx, key);
        if (JS_IsException(element)) return PV_WRITE_EXCEPTION;
        int status = pv_skipped(ctx, element) ? (pv_byte(w, PV_NULL) ? PV_WRITE_OK : PV_WRITE_FAILED)
                                              : pv_write(w, ctx, element, depth + 1);
        JS_FreeValue(ctx, element);
        if (status != PV_WRITE_OK) return status;
    }
    return PV_WRITE_OK;
}

static int pv_write_object(PVWriter *w, JSContext *ctx, JSValueConst object, int depth) {
    JSPropertyEnum *properties = NULL;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &properties, &count, object, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        return PV_WRITE_EXCEPTION;
    }
    JSValue *values = count ? calloc(count, sizeof(JSValue)) : NULL;
    uint32_t *indexes = count ? calloc(count, sizeof(uint32_t)) : NULL;
    int status = PV_WRITE_OK;
    uint32_t kept = 0;
    if (count && (!values || !indexes)) {
        w->error = "Out of memory while encoding the visual.";
        status = PV_WRITE_FAILED;
    }
    // Read every member first, like JSON.stringify, so the count excludes skipped members.
    for (uint32_t i = 0; status == PV_WRITE_OK && i < count; i++) {
        JSValue key = JS_AtomToString(ctx, properties[i].atom);
        if (JS_IsException(key)) {
            status = PV_WRITE_EXCEPTION;
            break;
        }
        JSValue member = pv_resolve(ctx, JS_GetProperty(ctx, object, properties[i].atom), key);
        JS_FreeValue(ctx, key);
        if (JS_IsException(member)) {
            status = PV_WRITE_EXCEPTION;
            break;
        }
        if (pv_skipped(ctx, member)) {
            JS_FreeValue(ctx, member);
            continue;
        }
        values[kept] = member;
        indexes[kept] = i;
        kept++;
    }
    if (status == PV_WRITE_OK && (!pv_byte(w, PV_OBJECT) || !pv_varint(w, kept))) status = PV_WRITE_FAILED;
    for (uint32_t i = 0; status == PV_WRITE_OK && i < kept; i++) {
        size_t length;
        const char *key = JS_AtomToCStringLen(ctx, &length, properties[indexes[i]].atom);
        if (!key) {
            status = PV_WRITE_EXCEPTION;
            break;
        }
        bool written = pv_string(w, key, length);
        JS_FreeCString(ctx, key);
        status = written ? pv_write(w, ctx, values[i], depth + 1) : PV_WRITE_FAILED;
    }
    for (uint32_t i = 0; i < kept; i++) JS_FreeValue(ctx, values[i]);
    free(values);
    free(indexes);
    JS_FreePropertyEnum(ctx, properties, count);
    return status;
}

static int pv_write(PVWriter *w, JSContext *ctx, JSValueConst value, int depth) {
    if (depth > PV_MAX_DEPTH) {
        w->error = "The visual's tree is nested too deeply or contains a cycle.";
        return PV_WRITE_FAILED;
    }
    if (JS_IsNull(value) || JS_IsUndefined(value)) return pv_byte(w, PV_NULL) ? PV_WRITE_OK : PV_WRITE_FAILED;
    if (JS_IsBool(value)) return pv_byte(w, JS_ToBool(ctx, value) ? PV_TRUE : PV_FALSE) ? PV_WRITE_OK : PV_WRITE_FAILED;
    if (JS_IsNumber(value)) {
        double number;
        if (JS_ToFloat64(ctx, &number, value) < 0) return PV_WRITE_EXCEPTION;
        return pv_number(w, number) ? PV_WRITE_OK : PV_WRITE_FAILED;
    }
    if (JS_IsString(value)) {
        size_t length;
        const char *text = JS_ToCStringLen(ctx, &length, value);
        if (!text) return PV_WRITE_EXCEPTION;
        bool written = pv_byte(w, PV_STRING) && pv_string(w, text, length);
        JS_FreeCString(ctx, text);
        return written ? PV_WRITE_OK : PV_WRITE_FAILED;
    }
    if (JS_IsBigInt(value)) {
        w->error = "BigInt values cannot be shown in a visual.";
        return PV_WRITE_FAILED;
    }
    if (JS_IsArray(value)) return pv_write_array(w, ctx, value, depth);
    if (JS_IsObject(value) && !JS_IsFunction(ctx, value)) return pv_write_object(w, ctx, value, depth);
    return pv_byte(w, PV_NULL) ? PV_WRITE_OK : PV_WRITE_FAILED;
}

// MARK: - Engine

static int pv_interrupt(JSRuntime *runtime, void *opaque) {
    (void)runtime;
    PVEngine *engine = opaque;
    if (engine->deadline && pv_now_ns() > engine->deadline) {
        engine->timed_out = true;
        return 1;
    }
    return 0;
}

const char *pv_engine_version(void) { return JS_GetVersion(); }

PVEngine *pv_engine_create(PVLimits limits) {
    PVEngine *engine = calloc(1, sizeof(PVEngine));
    if (!engine) return NULL;
    engine->limits = limits;
    engine->api = engine->load = engine->render = engine->event = engine->state = engine->logs = JS_UNDEFINED;
    engine->draw = engine->frame = JS_UNDEFINED;
    engine->runtime = JS_NewRuntime();
    if (!engine->runtime) {
        free(engine);
        return NULL;
    }
    JS_SetMemoryLimit(engine->runtime, limits.heap_bytes);
    JS_SetMaxStackSize(engine->runtime, limits.stack_bytes);
    JS_SetInterruptHandler(engine->runtime, pv_interrupt, engine);
    // Atomics.wait would block past the interrupt handler.
    JS_SetCanBlock(engine->runtime, false);
    // The standard intrinsics without WeakRef/FinalizationRegistry, as in the kernel. No std/os modules, timers,
    // I/O or module loading exist in this build. CQuickJS is compiled with localtime_r as gmtime_r, so local time
    // is UTC like the kernel's timezoneOffset 0.
    JSContext *ctx = JS_NewContextRaw(engine->runtime);
    if (!ctx || JS_AddIntrinsicBaseObjects(ctx) || JS_AddIntrinsicDate(ctx) || JS_AddIntrinsicEval(ctx) ||
        JS_AddIntrinsicRegExp(ctx) || JS_AddIntrinsicJSON(ctx) || JS_AddIntrinsicProxy(ctx) ||
        JS_AddIntrinsicMapSet(ctx) || JS_AddIntrinsicTypedArrays(ctx) || JS_AddIntrinsicPromise(ctx) ||
        JS_AddIntrinsicAToB(ctx) || JS_AddPerformance(ctx)) {
        if (ctx) JS_FreeContext(ctx);
        JS_FreeRuntime(engine->runtime);
        free(engine);
        return NULL;
    }
    engine->context = ctx;
    return engine;
}

void pv_engine_free(PVEngine *engine) {
    if (!engine) return;
    JSValue *values[] = { &engine->api, &engine->load, &engine->render, &engine->event, &engine->state, &engine->logs,
                          &engine->draw, &engine->frame };
    for (size_t i = 0; i < sizeof values / sizeof *values; i++) JS_FreeValue(engine->context, *values[i]);
    JS_FreeContext(engine->context);
    JS_FreeRuntime(engine->runtime);
    free(engine);
}

size_t pv_engine_memory_used(PVEngine *engine) {
    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(engine->runtime, &usage);
    return (size_t)usage.malloc_size;
}

void pv_buffer_free(PVBuffer *buffer) {
    if (!buffer) return;
    free(buffer->bytes);
    buffer->bytes = NULL;
    buffer->length = 0;
}

static uint32_t pv_phase_ms(PVEngine *engine, PVPhase phase) {
    switch (phase) {
    case PV_PHASE_SETUP: return engine->limits.setup_ms;
    case PV_PHASE_VIEW: return engine->limits.view_ms;
    case PV_PHASE_HANDLER: return engine->limits.handler_ms;
    case PV_PHASE_DRAW: return engine->limits.draw_ms;
    default: return 0;
    }
}

/// Starts a phase's time limit. PV_PHASE_NONE runs unbounded, like the kernel's state() and logs() calls.
static void pv_begin(PVEngine *engine, PVPhase phase) {
    JS_UpdateStackTop(engine->runtime);
    engine->timed_out = false;
    engine->phase = phase;
    uint32_t ms = pv_phase_ms(engine, phase);
    engine->deadline = ms ? pv_now_ns() + (uint64_t)ms * 1000000u : 0;
}

static void pv_end(PVEngine *engine) { engine->deadline = 0; }

/// Copies at most limit bytes of text, backing off to a UTF-8 boundary.
static size_t pv_clip(const char *text, size_t length, size_t limit) {
    if (length <= limit) return length;
    size_t end = limit;
    while (end > 0 && ((unsigned char)text[end] & 0xc0) == 0x80) end--;
    return end;
}

static int pv_line(const char *stack) {
    if (!stack) return 0;
    const char *marker = strstr(stack, PV_SOURCE_NAME ":");
    if (!marker) return 0;
    return atoi(marker + strlen(PV_SOURCE_NAME ":"));
}

static void pv_finish(PVWriter *w, PVBuffer *result) {
    result->bytes = w->bytes;
    result->length = w->length;
    w->bytes = NULL;
    pv_writer_free(w);
}

/// Writes { ok: false, error: { kind, message, line?, stack? } }. Returns 1.
static int pv_error(PVBuffer *result, const char *kind, const char *message, size_t message_length,
                    const char *stack, size_t stack_length) {
    PVWriter w = { 0 };
    int line = pv_line(stack);
    message_length = pv_clip(message, message_length, PV_MAX_MESSAGE);
    stack_length = stack ? pv_clip(stack, stack_length, PV_MAX_STACK_TEXT) : 0;
    uint64_t fields = 2 + (line > 0) + (stack_length > 0);
    bool written = pv_header(&w) && pv_byte(&w, PV_OBJECT) && pv_varint(&w, 2) && pv_key(&w, "ok") &&
                   pv_byte(&w, PV_FALSE) && pv_key(&w, "error") && pv_byte(&w, PV_OBJECT) &&
                   pv_varint(&w, fields) && pv_key(&w, "kind") && pv_cstring(&w, kind) && pv_key(&w, "message") &&
                   pv_byte(&w, PV_STRING) && pv_string(&w, message, message_length);
    if (written && line > 0) written = pv_key(&w, "line") && pv_number(&w, line);
    if (written && stack_length > 0) written = pv_key(&w, "stack") && pv_byte(&w, PV_STRING) &&
                                               pv_string(&w, stack, stack_length);
    if (!written) {
        // Only allocation can fail here. Leave an empty buffer, which the host reports as an engine failure.
        pv_writer_free(&w);
        *result = (PVBuffer){ 0 };
        return 1;
    }
    pv_finish(&w, result);
    return 1;
}

static int pv_static_error(PVBuffer *result, const char *kind, const char *message) {
    return pv_error(result, kind, message, strlen(message), NULL, 0);
}

/// Reads a string property of an error, or NULL.
static const char *pv_error_text(JSContext *ctx, JSValueConst error, const char *name, size_t *length) {
    JSValue value = JS_GetPropertyStr(ctx, error, name);
    const char *text = JS_IsString(value) ? JS_ToCStringLen(ctx, length, value) : NULL;
    JS_FreeValue(ctx, value);
    if (!text) JS_FreeValue(ctx, JS_GetException(ctx));
    return text;
}

/// Reports the pending exception in the contract's words: interrupts name the phase, memory exhaustion the limit,
/// VisualError its message alone and other errors "Name: message", with the first visual.js line of the stack.
static int pv_exception(PVEngine *engine, PVBuffer *result) {
    JSContext *ctx = engine->context;
    JSValue exception = JS_GetException(ctx);
    bool timed_out = engine->timed_out;
    PVPhase phase = engine->phase;
    pv_end(engine);
    const char *kind = "script";
    char message[160];
    const char *text = NULL;
    const char *name = NULL;
    const char *stack = NULL;
    size_t text_length = 0, name_length = 0, stack_length = 0;
    if (JS_IsError(exception)) {
        name = pv_error_text(ctx, exception, "name", &name_length);
        text = pv_error_text(ctx, exception, "message", &text_length);
        stack = pv_error_text(ctx, exception, "stack", &stack_length);
    }
    const char *body = NULL;
    size_t body_length = 0;
    char *combined = NULL;
    if (timed_out && phase != PV_PHASE_NONE) {
        kind = "timeout";
        snprintf(message, sizeof message, "%s took longer than %u ms",
                 phase == PV_PHASE_SETUP  ? "the visual function"
                 : phase == PV_PHASE_VIEW ? "the view"
                 : phase == PV_PHASE_DRAW ? "the drawing"
                                          : "the handler",
                 pv_phase_ms(engine, phase));
        body = message;
        body_length = strlen(message);
    } else if ((text && strstr(text, "out of memory")) || JS_IsNull(exception)) {
        // QuickJS throws null when even the out-of-memory error can't be allocated.
        kind = "memory";
        snprintf(message, sizeof message, "the visual used more than %zu MiB of memory",
                 engine->limits.heap_bytes >> 20);
        body = message;
        body_length = strlen(message);
    } else if (text) {
        if (strcmp(text, "Maximum call stack size exceeded") == 0) kind = "stack";
        if (name && strcmp(name, "VisualError") != 0) {
            combined = malloc(name_length + 2 + text_length + 1);
            if (combined) {
                memcpy(combined, name, name_length);
                memcpy(combined + name_length, ": ", 2);
                memcpy(combined + name_length + 2, text, text_length);
                body_length = name_length + 2 + text_length;
                combined[body_length] = 0;
                body = combined;
            }
        }
        if (!body) {
            body = text;
            body_length = text_length;
        }
    } else if (!JS_IsError(exception)) {
        // A thrown non-Error value, such as a string.
        text = JS_ToCStringLen(ctx, &text_length, exception);
        if (!text) JS_FreeValue(ctx, JS_GetException(ctx));
        body = text;
        body_length = text_length;
    }
    if (!body) {
        body = "the visual threw an error without a message";
        body_length = strlen(body);
    }
    int status = pv_error(result, kind, body, body_length, stack, stack_length);
    free(combined);
    if (name) JS_FreeCString(ctx, name);
    if (text) JS_FreeCString(ctx, text);
    if (stack) JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, exception);
    return status;
}

/// Calls a runtime function under a phase's limit. Returns its result, or JS_EXCEPTION with the error pending.
static JSValue pv_call(PVEngine *engine, PVPhase phase, JSValueConst function, int count, JSValueConst *arguments) {
    pv_begin(engine, phase);
    JSValue value = JS_Call(engine->context, function, engine->api, count, arguments);
    if (!JS_IsException(value)) pv_end(engine);
    return value;
}

/// Drops console output the runtime collected; the app shows none, and the runtime bounds it between calls.
static void pv_drain_logs(PVEngine *engine) {
    JSValue logs = pv_call(engine, PV_PHASE_NONE, engine->logs, 0, NULL);
    if (JS_IsException(logs)) JS_FreeValue(engine->context, JS_GetException(engine->context));
    JS_FreeValue(engine->context, logs);
    pv_end(engine);
}

/// Renders, then writes { ok: true, tree, state, changed? }. changed is the event's JSON result or undefined.
static int pv_frame(PVEngine *engine, double now, JSValueConst changed, PVBuffer *result) {
    JSContext *ctx = engine->context;
    JSValue argument = JS_NewFloat64(ctx, now);
    JSValue tree_json = pv_call(engine, PV_PHASE_VIEW, engine->render, 1, &argument);
    if (JS_IsException(tree_json)) return pv_exception(engine, result);
    JSValue state_json = pv_call(engine, PV_PHASE_NONE, engine->state, 0, NULL);
    if (JS_IsException(state_json)) {
        JS_FreeValue(ctx, tree_json);
        return pv_exception(engine, result);
    }
    size_t tree_length = 0, state_length = 0;
    const char *tree_text = JS_IsString(tree_json) ? JS_ToCStringLen(ctx, &tree_length, tree_json) : NULL;
    const char *state_text = JS_IsString(state_json) ? JS_ToCStringLen(ctx, &state_length, state_json) : NULL;
    JS_FreeValue(ctx, tree_json);
    JS_FreeValue(ctx, state_json);
    // The runtime returns JSON text; parse it here to write the tree in the wire encoding.
    JSValue tree = tree_text ? JS_ParseJSON(ctx, tree_text, tree_length, "tree.json") : JS_UNDEFINED;
    if (tree_text) JS_FreeCString(ctx, tree_text);
    if (JS_IsException(tree) || !tree_text || !state_text) {
        if (state_text) JS_FreeCString(ctx, state_text);
        if (JS_IsException(tree)) return pv_exception(engine, result);
        JS_FreeValue(ctx, tree);
        return pv_static_error(result, "result", "The visual runtime returned no tree or state.");
    }
    PVWriter w = { 0 };
    bool has_changed = !JS_IsUndefined(changed);
    int status = PV_WRITE_FAILED;
    if (pv_header(&w) && pv_byte(&w, PV_OBJECT) && pv_varint(&w, has_changed ? 4 : 3) && pv_key(&w, "ok") &&
        pv_byte(&w, PV_TRUE) && pv_key(&w, "tree")) {
        status = pv_write(&w, ctx, tree, 0);
    }
    if (status == PV_WRITE_OK && !(pv_key(&w, "state") && pv_byte(&w, PV_STRING) &&
                                   pv_string(&w, state_text, state_length))) {
        status = PV_WRITE_FAILED;
    }
    if (status == PV_WRITE_OK && has_changed) status = pv_key(&w, "changed") ? pv_write(&w, ctx, changed, 0)
                                                                              : PV_WRITE_FAILED;
    JS_FreeCString(ctx, state_text);
    JS_FreeValue(ctx, tree);
    if (status == PV_WRITE_EXCEPTION) {
        pv_writer_free(&w);
        return pv_exception(engine, result);
    }
    if (status != PV_WRITE_OK) {
        const char *message = w.error ? w.error : "The visual's tree could not be encoded.";
        int error = pv_static_error(result, "result", message);
        pv_writer_free(&w);
        return error;
    }
    pv_finish(&w, result);
    return 0;
}

/// JS_Eval and JS_ParseJSON need a terminated buffer.
static char *pv_terminated(const char *text, size_t length, const char *before, const char *after) {
    size_t prefix = before ? strlen(before) : 0;
    size_t suffix = after ? strlen(after) : 0;
    char *copy = malloc(prefix + length + suffix + 1);
    if (!copy) return NULL;
    if (prefix) memcpy(copy, before, prefix);
    if (length) memcpy(copy + prefix, text, length);
    if (suffix) memcpy(copy + prefix + length, after, suffix);
    copy[prefix + length + suffix] = 0;
    return copy;
}

/// Evaluates text as a global script under a phase's limit. Returns the completion value or JS_EXCEPTION.
static JSValue pv_eval(PVEngine *engine, PVPhase phase, const char *text, size_t length, const char *before,
                       const char *after, const char *filename) {
    char *script = pv_terminated(text, length, before, after);
    if (!script) return JS_ThrowOutOfMemory(engine->context);
    pv_begin(engine, phase);
    JSValue value = JS_Eval(engine->context, script, strlen(script), filename, JS_EVAL_TYPE_GLOBAL);
    free(script);
    if (!JS_IsException(value)) pv_end(engine);
    return value;
}

static JSValue pv_string_or_undefined(JSContext *ctx, const char *text, size_t length) {
    return text ? JS_NewStringLen(ctx, text, length) : JS_UNDEFINED;
}

int pv_engine_load(PVEngine *engine, const char *runtime, size_t runtime_length, const char *source,
                   size_t source_length, const char *data_json, size_t data_length, const char *state_json,
                   size_t state_length, const char *seed, size_t seed_length, double now, PVBuffer *result) {
    *result = (PVBuffer){ 0 };
    if (engine->loaded) return pv_static_error(result, "state", "This visual engine is already loaded.");
    engine->loaded = true;
    JSContext *ctx = engine->context;

    // The runtime defines no globals: its completion value is the API.
    JSValue api = pv_eval(engine, PV_PHASE_SETUP, runtime, runtime_length, NULL, NULL, PV_RUNTIME_NAME);
    if (JS_IsException(api)) return pv_exception(engine, result);
    engine->api = api;
    const char *names[] = { "load", "render", "event", "state", "logs", "draw", "frame" };
    JSValue *functions[] = { &engine->load, &engine->render, &engine->event, &engine->state, &engine->logs,
                             &engine->draw, &engine->frame };
    for (int i = 0; i < 7; i++) {
        *functions[i] = JS_IsObject(api) ? JS_GetPropertyStr(ctx, api, names[i]) : JS_UNDEFINED;
        if (JS_IsException(*functions[i])) {
            *functions[i] = JS_UNDEFINED;
            return pv_exception(engine, result);
        }
        if (!JS_IsFunction(ctx, *functions[i])) {
            return pv_static_error(result, "state", "The visual runtime is missing one of its host functions.");
        }
    }

    // Strict mode, on the source's own first line so stack lines are the function's lines. The closing parenthesis
    // goes on a new line in case the source ends with a line comment.
    JSValue visual = pv_eval(engine, PV_PHASE_SETUP, source, source_length, PV_SOURCE_PREFIX, "\n)", PV_SOURCE_NAME);
    if (JS_IsException(visual)) return pv_exception(engine, result);
    JSValue arguments[6] = {
        visual,
        JS_NewStringLen(ctx, source, source_length),
        JS_NewStringLen(ctx, data_json, data_length),
        pv_string_or_undefined(ctx, state_json, state_length),
        JS_NewStringLen(ctx, seed, seed_length),
        JS_NewFloat64(ctx, now),
    };
    JSValue loaded = pv_call(engine, PV_PHASE_SETUP, engine->load, 6, arguments);
    for (int i = 0; i < 6; i++) JS_FreeValue(ctx, arguments[i]);
    if (JS_IsException(loaded)) {
        int status = pv_exception(engine, result);
        pv_drain_logs(engine);
        return status;
    }
    JS_FreeValue(ctx, loaded);
    int status = pv_frame(engine, now, JS_UNDEFINED, result);
    pv_drain_logs(engine);
    engine->ready = status == 0;
    return status;
}

int pv_engine_event(PVEngine *engine, const char *id, size_t id_length, const char *value_json, size_t value_length,
                    double now, PVBuffer *result) {
    *result = (PVBuffer){ 0 };
    if (!engine->ready) return pv_static_error(result, "unloaded", "This visual is not loaded.");
    JSContext *ctx = engine->context;
    JSValue arguments[3] = {
        JS_NewStringLen(ctx, id, id_length),
        pv_string_or_undefined(ctx, value_json, value_length),
        JS_NewFloat64(ctx, now),
    };
    JSValue changed_json = pv_call(engine, PV_PHASE_HANDLER, engine->event, 3, arguments);
    for (int i = 0; i < 3; i++) JS_FreeValue(ctx, arguments[i]);
    if (JS_IsException(changed_json)) {
        int status = pv_exception(engine, result);
        pv_drain_logs(engine);
        return status;
    }
    // {"changed":[keys]}: pass the keys along, so the app knows which state the handler assigned.
    JSValue changed = JS_UNDEFINED;
    size_t length = 0;
    const char *text = JS_IsString(changed_json) ? JS_ToCStringLen(ctx, &length, changed_json) : NULL;
    JS_FreeValue(ctx, changed_json);
    if (text) {
        JSValue parsed = JS_ParseJSON(ctx, text, length, "changed.json");
        JS_FreeCString(ctx, text);
        if (JS_IsException(parsed)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else {
            changed = JS_GetPropertyStr(ctx, parsed, "changed");
            JS_FreeValue(ctx, parsed);
            if (JS_IsException(changed)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                changed = JS_UNDEFINED;
            }
        }
    }
    int status = pv_frame(engine, now, changed, result);
    JS_FreeValue(ctx, changed);
    pv_drain_logs(engine);
    return status;
}

static void pv_put_u32(uint8_t *bytes, uint32_t value) {
    for (int i = 0; i < 4; i++) bytes[i] = (uint8_t)(value >> (8 * i));
}

/// Encodes the runtime's last frame() as a drawing, into out when it fits, else into a new buffer in *result.
static int pv_encode_drawing(PVEngine *engine, uint32_t commands, uint8_t *out, size_t capacity, size_t *written,
                             PVBuffer *result) {
    JSContext *ctx = engine->context;
    JSValue frame = pv_call(engine, PV_PHASE_NONE, engine->frame, 0, NULL);
    pv_end(engine);
    if (JS_IsException(frame)) return pv_exception(engine, result);
    JSValue ops = JS_GetPropertyStr(ctx, frame, "ops");
    JSValue strings = JS_GetPropertyStr(ctx, frame, "strings");
    JS_FreeValue(ctx, frame);
    int status = 0;
    const char **texts = NULL;
    size_t *lengths = NULL;
    int64_t count = 0;
    size_t offset = 0, length = 0, element = 0, buffer_size = 0;
    JSValue buffer = JS_UNDEFINED;
    const uint8_t *bytes = NULL;
    if (JS_GetTypedArrayType(ops) == JS_TYPED_ARRAY_FLOAT64) {
        buffer = JS_GetTypedArrayBuffer(ctx, ops, &offset, &length, &element);
        if (!JS_IsException(buffer)) bytes = JS_GetArrayBuffer(ctx, &buffer_size, buffer);
    }
    if (!bytes || offset + length > buffer_size || JS_GetLength(ctx, strings, &count) < 0 || count < 0 ||
        count > 1000000) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        status = pv_static_error(result, "result", "The visual runtime returned an invalid drawing.");
        goto done;
    }
    texts = count ? calloc((size_t)count, sizeof *texts) : NULL;
    lengths = count ? calloc((size_t)count, sizeof *lengths) : NULL;
    if (count && (!texts || !lengths)) {
        status = pv_static_error(result, "memory", "Out of memory while encoding the drawing.");
        goto done;
    }
    size_t string_bytes = 0;
    for (int64_t i = 0; i < count; i++) {
        JSValue item = JS_GetPropertyInt64(ctx, strings, i);
        texts[i] = JS_IsString(item) ? JS_ToCStringLen(ctx, &lengths[i], item) : NULL;
        JS_FreeValue(ctx, item);
        if (!texts[i]) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            status = pv_static_error(result, "result", "The visual runtime returned an invalid drawing.");
            goto done;
        }
        string_bytes += 4 + lengths[i];
    }
    size_t total = PV_DRAWING_HEADER + length + string_bytes;
    if (total > PV_MAX_DRAWING) {
        status = pv_static_error(result, "result", "The drawing is larger than 64 MiB.");
        goto done;
    }
    uint8_t *target = out;
    if (!out || total > capacity) {
        target = malloc(total);
        if (!target) {
            status = pv_static_error(result, "memory", "Out of memory while encoding the drawing.");
            goto done;
        }
        result->bytes = target;
        result->length = total;
    } else {
        *written = total;
    }
    memcpy(target, "PD\x01\x00", 4);
    pv_put_u32(target + 4, commands);
    pv_put_u32(target + 8, (uint32_t)(length / 8));
    pv_put_u32(target + 12, (uint32_t)count);
    pv_put_u32(target + 16, (uint32_t)string_bytes);
    pv_put_u32(target + 20, 0);
    // Doubles are little endian on every Mac this runs on.
    memcpy(target + PV_DRAWING_HEADER, bytes + offset, length);
    uint8_t *cursor = target + PV_DRAWING_HEADER + length;
    for (int64_t i = 0; i < count; i++) {
        pv_put_u32(cursor, (uint32_t)lengths[i]);
        memcpy(cursor + 4, texts[i], lengths[i]);
        cursor += 4 + lengths[i];
    }
done:
    if (texts) {
        for (int64_t i = 0; i < count; i++) {
            if (texts[i]) JS_FreeCString(ctx, texts[i]);
        }
    }
    free(texts);
    free(lengths);
    JS_FreeValue(ctx, buffer);
    JS_FreeValue(ctx, ops);
    JS_FreeValue(ctx, strings);
    return status;
}

int pv_engine_draw(PVEngine *engine, const char *id, size_t id_length, double width, double height, double t,
                   int has_pointer, double pointer_x, double pointer_y, uint8_t *out, size_t capacity,
                   size_t *written, PVBuffer *result) {
    *result = (PVBuffer){ 0 };
    *written = 0;
    if (!engine->ready) return pv_static_error(result, "unloaded", "This visual is not loaded.");
    JSContext *ctx = engine->context;
    JSValue arguments[6] = {
        JS_NewStringLen(ctx, id, id_length),
        JS_NewFloat64(ctx, width),
        JS_NewFloat64(ctx, height),
        JS_NewFloat64(ctx, t),
        has_pointer ? JS_NewFloat64(ctx, pointer_x) : JS_UNDEFINED,
        has_pointer ? JS_NewFloat64(ctx, pointer_y) : JS_UNDEFINED,
    };
    JSValue commands = pv_call(engine, PV_PHASE_DRAW, engine->draw, 6, arguments);
    for (int i = 0; i < 6; i++) JS_FreeValue(ctx, arguments[i]);
    if (JS_IsException(commands)) {
        int status = pv_exception(engine, result);
        pv_drain_logs(engine);
        return status;
    }
    double count = 0;
    if (JS_ToFloat64(ctx, &count, commands) < 0) JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeValue(ctx, commands);
    int status = pv_encode_drawing(engine, count > 0 && count < 4294967295.0 ? (uint32_t)count : 0, out, capacity,
                                   written, result);
    pv_drain_logs(engine);
    return status;
}
