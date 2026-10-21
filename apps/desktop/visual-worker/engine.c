#ifdef __linux__
#include <stdint.h>
#include <time.h>
#define CLOCK_UPTIME_RAW CLOCK_MONOTONIC
static uint64_t clock_gettime_nsec_np(clockid_t clock) { struct timespec t;clock_gettime(clock,&t);return (uint64_t)t.tv_sec*1000000000u+(uint64_t)t.tv_nsec; }
#endif
// Existing engine implementation, linked only into this separate helper package.
#include "../../macos/Sources/PilotVisualEngine/pilot_visual_engine.c"
