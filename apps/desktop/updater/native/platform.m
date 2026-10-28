#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/attr.h>
#include <stdio.h>
#include <sys/acl.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <libproc.h>
#include <stdlib.h>
#include <time.h>

bool pnu_bundle_build(const char *path, char *output, size_t capacity) {
    @autoreleasepool {
        if (NSThread.isMainThread || !path || !output || capacity < 2) return false;
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
        NSDictionary *info = [NSDictionary dictionaryWithContentsOfURL:[url URLByAppendingPathComponent:@"Contents/Info.plist"] error:NULL];
        id build = info[@"CFBundleVersion"];
        if (![build isKindOfClass:NSString.class]) return false;
        const char *text = [build UTF8String];
        if (!text || strlen(text) >= capacity) return false;
        memcpy(output, text, strlen(text) + 1);
        return true;
    }
}

int pnu_publish_capsule(const char *stage, const char *destination) {
    return renamex_np(stage, destination, RENAME_EXCL);
}

// Legacy stages had no inherited copier lease. Only the duplicate-recovery
// caller uses this bounded, fail-closed census, while holding the store lock.
// It is not permission to collect published runtimes or launch from staging.
static bool pnu_path_clear(const char *path, size_t capacity, const char *stage) {
    size_t length = strnlen(path, capacity);
    if (length >= capacity - 1) return false; // libproc paths can be truncated.
    size_t root = strlen(stage);
    return length < root || memcmp(path, stage, root) != 0 ||
        (path[root] != '\0' && path[root] != '/');
}

static bool pnu_vnode_clear(const struct vnode_info_path *info, const char *stage) {
    if (info->vip_vi.vi_stat.vst_ino && !info->vip_path[0]) return false;
    return pnu_path_clear(info->vip_path, sizeof(info->vip_path), stage);
}

static uint64_t pnu_milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return UINT64_MAX;
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static bool pnu_process_clear(const char *stage, int pid, int ignored_fd,
                              uint64_t end, unsigned *work, uint64_t *identity) {
    struct proc_bsdinfo before = {0}, after = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before) ||
        before.pbi_uid != geteuid()) return false;
    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0 ||
        !pnu_path_clear(executable, sizeof(executable), stage)) return false;
    const char *name = strrchr(executable, '/');
    // Even between file opens an old copier can still write the stage later.
    if (!name || strcmp(name + 1, "ditto") == 0) return false;
    struct proc_vnodepathinfo directories = {0};
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &directories, sizeof(directories)) != sizeof(directories) ||
        !pnu_vnode_clear(&directories.pvi_cdir, stage) ||
        !pnu_vnode_clear(&directories.pvi_rdir, stage)) return false;
    struct proc_fdinfo descriptors[4096];
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors, sizeof(descriptors));
    if (bytes <= 0 || bytes >= (int)sizeof(descriptors) || bytes % sizeof(descriptors[0])) return false;
    for (size_t i = 0; i < (size_t)bytes / sizeof(descriptors[0]); i++) {
        if (++*work > 131072 || pnu_milliseconds() >= end) return false;
        int fd = descriptors[i].proc_fd;
        if (pid == getpid() && fd == ignored_fd) continue; // caller's directory lease only
        if (descriptors[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
        struct vnode_fdinfowithpath info = {0};
        if (proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEPATHINFO, &info, sizeof(info)) != sizeof(info) ||
            !pnu_vnode_clear(&info.pvip, stage)) return false;
    }
    // Unknown Mach fileport references cannot silently count as no vnode users.
    struct proc_fileportinfo fileport;
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDLISTFILEPORTS, 0, &fileport, sizeof(fileport)) != 0 || errno != 0) return false;
    uint64_t address = 0;
    for (;;) {
        if (++*work > 131072 || pnu_milliseconds() >= end) return false;
        struct proc_regionwithpathinfo region = {0};
        errno = 0;
        int result = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region));
        // Darwin returns EINVAL after the final VM region. Every other failure
        // is unknown, never evidence that a mapped-file user is absent.
        if (result == 0 && errno == EINVAL) break;
        if (result != sizeof(region) || !pnu_vnode_clear(&region.prp_vip, stage)) return false;
        uint64_t next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
        if (next <= address || next < region.prp_prinfo.pri_address) return false;
        address = next;
    }
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) return false;
    if (before.pbi_start_tvsec != after.pbi_start_tvsec ||
        before.pbi_start_tvusec != after.pbi_start_tvusec || before.pbi_uid != after.pbi_uid) return false;
    *identity = after.pbi_start_tvsec * 1000000 + after.pbi_start_tvusec;
    return true;
}

// Same primitive exposed for scoped tests against owned fixture processes only.
bool pnu_stage_process_unused(const char *stage, int pid, int ignored_fd) {
    unsigned work = 0;
    uint64_t identity;
    return stage && stage[0] == '/' && pnu_process_clear(stage, pid, ignored_fd,
        pnu_milliseconds() + 2000, &work, &identity);
}

static int pnu_pid_compare(const void *a, const void *b) {
    int x = *(const int *)a, y = *(const int *)b;
    return (x > y) - (x < y);
}

bool pnu_stage_unused(const char *stage, int ignored_fd, unsigned timeout_ms) {
    if (!stage || stage[0] != '/' || strlen(stage) >= MAXPATHLEN - 1 || timeout_ms == 0) return false;
    int first[4096], last[4096];
    uint64_t identities[4096];
    int bytes = proc_listpids(PROC_UID_ONLY, geteuid(), first, sizeof(first));
    if (bytes <= 0 || bytes >= (int)sizeof(first) || bytes % sizeof(first[0])) return false;
    qsort(first, bytes / sizeof(first[0]), sizeof(first[0]), pnu_pid_compare);
    unsigned work = 0;
    uint64_t end = pnu_milliseconds() + (timeout_ms < 2000 ? timeout_ms : 2000);
    for (size_t i = 0; i < (size_t)bytes / sizeof(first[0]); i++) {
        if (first[i] <= 0 || !pnu_process_clear(stage, first[i], ignored_fd, end, &work, &identities[i])) return false;
    }
    int final_bytes = proc_listpids(PROC_UID_ONLY, geteuid(), last, sizeof(last));
    if (final_bytes != bytes || pnu_milliseconds() >= end) return false;
    qsort(last, final_bytes / sizeof(last[0]), sizeof(last[0]), pnu_pid_compare);
    if (memcmp(first, last, bytes) != 0) return false;
    for (size_t i = 0; i < (size_t)bytes / sizeof(first[0]); i++) {
        struct proc_bsdinfo identity = {0};
        if (pnu_milliseconds() >= end || proc_pidinfo(first[i], PROC_PIDTBSDINFO, 0,
            &identity, sizeof(identity)) != sizeof(identity) || identity.pbi_uid != geteuid() ||
            identity.pbi_start_tvsec * 1000000 + identity.pbi_start_tvusec != identities[i]) return false;
    }
    return true;
}

// Worker-only. The caller has authenticated the signed manifest before extraction.
// No updater networking, install-on-quit observer, app delegate patch or secret access.
bool pnu_verify_bundle(const char *path, const char *identifier, const char *build,
                       const char *short_version, const char *requirement) {
    @autoreleasepool {
        if (NSThread.isMainThread || !path || !identifier || !build || !requirement) return false;
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path] isDirectory:YES];
        // Read plist directly. NSBundle caches mutable paths across an atomic replacement.
        NSDictionary *info = [NSDictionary dictionaryWithContentsOfURL:[url URLByAppendingPathComponent:@"Contents/Info.plist"] error:NULL];
        if (![info[@"CFBundleIdentifier"] isEqual:[NSString stringWithUTF8String:identifier]] ||
            ![info[@"CFBundleVersion"] isEqual:[NSString stringWithUTF8String:build]] ||
            (short_version && ![info[@"CFBundleShortVersionString"] isEqual:[NSString stringWithUTF8String:short_version]]) ||
            ![info[@"CFBundlePackageType"] isEqual:@"APPL"]) return false;
        SecStaticCodeRef code = NULL;
        SecRequirementRef policy = NULL;
        OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
        if (status == errSecSuccess) status = SecRequirementCreateWithString((__bridge CFStringRef)[NSString stringWithUTF8String:requirement], kSecCSDefaultFlags, &policy);
        if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, policy);
        if (policy) CFRelease(policy);
        if (code) CFRelease(code);
        return status == errSecSuccess;
    }
}

// A single same-volume namespace operation. Old app remains in staging for recovery.
int pnu_swap(int parent, const char *staged, const char *installed) {
    return renameatx_np(parent, staged, parent, installed, RENAME_SWAP);
}

// policy0: existing path, reject write-capable extended allow entries.
// policy1: strip ACLs ONLY on a just-created private stage, then require no allows.
// policy2: existing private stage, require no extended allow entries at all.
bool pnu_acl_policy(const char *path, int policy) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return false;
    if (policy == 1) {
        acl_t empty = acl_init(0);
        if (!empty) { close(fd); return false; }
        int result = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED);
        acl_free(empty);
        if (result != 0) { close(fd); return false; }
    }
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    int acl_error = errno;
    close(fd);
    // Darwin reports ENOENT for no extended ACL even on an existing object. The
    // successfully opened, no-follow descriptor distinguishes that from a missing path.
    if (!acl) return acl_error == ENOENT;
    if (acl_valid(acl) != 0) { acl_free(acl); return false; }
    acl_entry_t entry;
    int position = ACL_FIRST_ENTRY;
    bool safe = true;
    int result;
    while ((result = acl_get_entry(acl, position, &entry)) == 0) {
        position = ACL_NEXT_ENTRY;
        acl_tag_t tag;
        acl_permset_t permissions;
        if (acl_get_tag_type(entry, &tag) != 0 || acl_get_permset(entry, &permissions) != 0) { safe = false; break; }
        if (tag != ACL_EXTENDED_ALLOW) continue;
        if (policy != 0) { safe = false; break; }
        acl_perm_t unsafe[] = { ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_DELETE, ACL_DELETE_CHILD,
            ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER };
        for (unsigned index = 0; index < sizeof(unsafe) / sizeof(unsafe[0]); index++) {
            if (acl_get_perm_np(permissions, unsafe[index]) != 0) { safe = false; break; }
        }
        if (!safe) break;
    }
    // Darwin returns -1 at the end of iteration. Other retrieval errors are also
    // refused when errno is not the documented end-of-list EINVAL.
    if (result != 0 && errno != EINVAL && errno != 0) safe = false;
    acl_free(acl);
    return safe;
}
