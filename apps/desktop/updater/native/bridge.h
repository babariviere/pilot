#include <stdint.h>
#include <stdbool.h>

// Main-thread-only. No credentials or signed URLs cross the event boundary.
typedef struct {
    uint64_t operation;
    int32_t kind; // 0 none, 1 current, 2 available (UNVERIFIED), 3 error, 4 cancelled
    int32_t error;
    char version[81];
} PNUEvent;

bool pnu_is_main_thread(void);
typedef void (*PNUWake)(void *context);
void *pnu_create(const char *expected_bundle_id, PNUWake wake, void *context);
int32_t pnu_check(void *handle, uint64_t operation, const char *explicit_approved_token);
void pnu_cancel(void *handle, uint64_t operation);
bool pnu_take_event(void *handle, PNUEvent *event);
void pnu_destroy(void *handle);
