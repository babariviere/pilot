#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/attr.h>
#include <stdio.h>
#include <sys/acl.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

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
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
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
