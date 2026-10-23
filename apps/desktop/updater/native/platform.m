#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <sys/attr.h>
#include <stdio.h>

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
