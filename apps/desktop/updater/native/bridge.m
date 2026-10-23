// Thin public-API Sparkle adapter. No private Sparkle symbols, crypto or installer.
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#import "bridge.h"

enum { PNUUnconfigured = 1, PNUAuth = 2, PNUOffline = 3, PNUResponse = 4,
       PNURedirect = 5, PNUIdentity = 6, PNUVersion = 7, PNUSignature = 8,
       PNUBusy = 9, PNUNative = 10 };
static const NSUInteger PNUMaxMetadata = 1024 * 1024;

static BOOL PNURepository(NSString *value) {
    if (![value isKindOfClass:NSString.class] || value.length > 200) return NO;
    NSArray *parts = [value componentsSeparatedByString:@"/"];
    NSCharacterSet *denied = [[NSCharacterSet characterSetWithCharactersInString:
        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."] invertedSet];
    if (parts.count != 2) return NO;
    for (NSString *part in parts) {
        if (!part.length || [part isEqual:@"."] || [part isEqual:@".."] ||
            [part rangeOfCharacterFromSet:denied].location != NSNotFound) return NO;
    }
    return YES;
}

static BOOL PNUPlainHTTPS(NSURL *url, NSString *host) {
    return [url.scheme isEqual:@"https"] && [url.host isEqual:host] && !url.port &&
        !url.user && !url.password && !url.fragment;
}

static BOOL PNUCDN(NSURL *url) {
    return PNUPlainHTTPS(url, @"release-assets.githubusercontent.com") && url.path.length > 1;
}

static BOOL PNUVersionString(NSString *value) {
    if (![value isKindOfClass:NSString.class] || !value.length || value.length > 80) return NO;
    NSArray *parts = [value componentsSeparatedByString:@"."];
    if (parts.count > 4) return NO;
    for (NSString *part in parts) {
        if (!part.length || part.length > 9 || [part rangeOfCharacterFromSet:
                [[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet]].location != NSNotFound) return NO;
    }
    return YES;
}

static BOOL PNUBase64(NSString *value, NSUInteger length) {
    if (![value isKindOfClass:NSString.class]) return NO;
    NSData *decoded = [[NSData alloc] initWithBase64EncodedString:value options:0];
    return decoded.length == length && [[decoded base64EncodedStringWithOptions:0] isEqual:value];
}

static BOOL PNUHost(NSBundle *bundle, NSString *expected) {
    NSDictionary *info = bundle.infoDictionary;
    return expected.length && ![expected isEqual:@"com.babariviere.pilot"] &&
        [bundle.bundleIdentifier isEqual:expected] && [bundle.bundleURL.pathExtension isEqual:@"app"] &&
        [info[@"PilotNextUpdaterIdentity"] isEqual:@"rust-macos-v1"] &&
        [info[@"PilotNextUpdateChannel"] isEqual:@"desktop-stable"] &&
        PNURepository(info[@"PilotNextUpdateRepository"]) &&
        PNUVersionString(info[@"CFBundleVersion"]) && PNUBase64(info[@"SUPublicEDKey"], 32) &&
        [info[@"SUEnableAutomaticChecks"] isEqual:@NO] &&
        [info[@"SUAllowsAutomaticUpdates"] isEqual:@NO] &&
        [info[@"SUAutomaticallyUpdate"] isEqual:@NO];
}

static NSURL *PNUAsset(NSString *repository, NSNumber *identifier) {
    if (![identifier isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)identifier) == CFBooleanGetTypeID() ||
        identifier.longLongValue <= 0 || identifier.doubleValue != identifier.longLongValue) return nil;
    return [NSURL URLWithString:[NSString stringWithFormat:@"https://api.github.com/repos/%@/releases/assets/%lld", repository, identifier.longLongValue]];
}

static NSArray<NSURL *> *PNURelease(NSData *data, NSString *repository) {
    id release = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (![release isKindOfClass:NSDictionary.class] || ![release[@"draft"] isEqual:@NO] ||
        ![release[@"prerelease"] isEqual:@NO] || ![release[@"tag_name"] isKindOfClass:NSString.class] ||
        ![release[@"tag_name"] hasPrefix:@"desktop-v"] || ![release[@"assets"] isKindOfClass:NSArray.class]) return nil;
    NSMutableArray *feeds = [NSMutableArray array], *archives = [NSMutableArray array];
    for (id asset in release[@"assets"]) {
        if (![asset isKindOfClass:NSDictionary.class] || ![asset[@"state"] isEqual:@"uploaded"]) continue;
        NSURL *url = PNUAsset(repository, asset[@"id"]);
        if (!url) continue;
        if ([asset[@"name"] isEqual:@"appcast-desktop-macos-arm64.xml"]) [feeds addObject:url];
        if ([asset[@"name"] isEqual:@"Pilot-Next-macos-arm64.zip"]) [archives addObject:url];
    }
    if (feeds.count != 1 || archives.count != 1 || [feeds[0] isEqual:archives[0]]) return nil;
    return @[feeds[0], archives[0]];
}

@interface PNUBridge : NSObject <SPUUpdaterDelegate, SPUUserDriver, NSURLSessionDataDelegate>
@property NSBundle *host;
@property NSString *repository;
@property NSURLSession *session;
@property NSURLSessionDataTask *task;
@property NSMutableData *data;
@property NSHTTPURLResponse *response;
@property SPUUpdater *updater;
@property NSURL *feed;
@property NSURL *archive;
@property NSString *token;
@property(copy) void (^cancellation)(void);
@property uint64_t operation;
@property BOOL active;
@property BOOL cancelling;
@property BOOL destroyed;
@property BOOL resolving;
@property int32_t networkError;
@property PNUEvent event;
@property PNUEvent pending;
@property PNUWake wake;
@property void *wakeContext;
@end

@implementation PNUBridge
- (void)finish:(int32_t)kind error:(int32_t)error version:(NSString *)version {
    NSAssert(NSThread.isMainThread, @"main thread");
    if (!self.active || self.destroyed) return;
    PNUEvent event = { .operation = self.operation, .kind = self.cancelling ? 4 : kind, .error = error };
    if (version && [version lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 80) {
        [version getCString:event.version maxLength:sizeof(event.version) encoding:NSUTF8StringEncoding];
    }
    self.event = event;
    self.active = NO;
    self.cancellation = nil;
    self.token = nil;
    self.feed = nil;
    self.archive = nil;
    self.task = nil;
    self.data = nil;
    self.response = nil;
    [self.session finishTasksAndInvalidate];
    self.session = nil;
    if (self.wake) self.wake(self.wakeContext);
}

- (void)fetch:(NSURL *)url resolving:(BOOL)resolving {
    self.resolving = resolving;
    self.data = [NSMutableData data];
    self.response = nil;
    self.networkError = 0;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:30];
    // Only called with constructed, exact-repository API URLs. No automatic redirect.
    [request setValue:[@"Bearer " stringByAppendingString:self.token] forHTTPHeaderField:@"Authorization"];
    [request setValue:resolving ? @"application/octet-stream" : @"application/vnd.github+json" forHTTPHeaderField:@"Accept"];
    [request setValue:@"2022-11-28" forHTTPHeaderField:@"X-GitHub-Api-Version"];
    [request setValue:@"Pilot-Next-Updater" forHTTPHeaderField:@"User-Agent"];
    self.task = [self.session dataTaskWithRequest:request];
    [self.task resume];
}

- (NSURLSessionConfiguration *)sessionConfiguration { return NSURLSessionConfiguration.ephemeralSessionConfiguration; }
- (int32_t)begin:(uint64_t)operation token:(NSString *)token {
    if (self.active || self.event.kind || self.updater.sessionInProgress) return PNUBusy;
    if (!token.length || token.length > 65536 || [token rangeOfCharacterFromSet:
        [[NSCharacterSet characterSetWithRange:NSMakeRange(0x21, 0x7e - 0x21 + 1)] invertedSet]].location != NSNotFound) return PNUAuth;
    self.operation = operation;
    self.active = YES;
    self.cancelling = NO;
    self.pending = (PNUEvent){0};
    self.token = token;
    NSURLSessionConfiguration *configuration = [self sessionConfiguration];
    configuration.timeoutIntervalForRequest = 30;
    configuration.timeoutIntervalForResource = 60;
    configuration.HTTPMaximumConnectionsPerHost = 1;
    configuration.HTTPCookieStorage = nil;
    configuration.URLCache = nil;
    // Serialized MAIN queue for tiny metadata callbacks only. NSURLSession does network I/O off-main.
    // JSON decoding (<=1MiB) is explicitly dispatched off-main below.
    self.session = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:NSOperationQueue.mainQueue];
    [self fetch:[NSURL URLWithString:[NSString stringWithFormat:@"https://api.github.com/repos/%@/releases/latest", self.repository]] resolving:NO];
    return 0;
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))handler {
    // Retain the original 3xx. Never follow while holding Authorization.
    handler(nil);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))handler {
    if (![response isKindOfClass:NSHTTPURLResponse.class] || response.expectedContentLength > (int64_t)PNUMaxMetadata) {
        self.networkError = PNUResponse;
        handler(NSURLSessionResponseCancel);
    } else { self.response = (NSHTTPURLResponse *)response; handler(NSURLSessionResponseAllow); }
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    if (data.length > PNUMaxMetadata - self.data.length) { self.networkError = PNUResponse; [task cancel]; }
    else [self.data appendData:data];
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    if (!self.active || self.destroyed) return;
    if (self.cancelling) { [self finish:4 error:0 version:nil]; return; }
    if (self.networkError || error) { [self finish:3 error:self.networkError ?: PNUOffline version:nil]; return; }
    NSInteger status = self.response.statusCode;
    if (status == 401 || status == 403 || status == 404) { [self finish:3 error:PNUAuth version:nil]; return; }
    if (self.resolving) {
        NSURL *cdn = [NSURL URLWithString:[self.response valueForHTTPHeaderField:@"Location"] ?: @""];
        if (![@[@301, @302, @303, @307, @308] containsObject:@(status)] || !PNUCDN(cdn)) {
            [self finish:3 error:PNURedirect version:nil]; return;
        }
        self.feed = cdn;
        self.token = nil; // Sparkle NEVER receives private API credentials.
        [self.session finishTasksAndInvalidate]; self.session = nil; self.task = nil;
        [self startProbe];
    } else {
        if (status != 200) { [self finish:3 error:status >= 300 && status < 400 ? PNURedirect : PNUResponse version:nil]; return; }
        NSData *data = [self.data copy]; NSString *repository = self.repository; uint64_t operation = self.operation;
        __weak PNUBridge *weakSelf = self;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            NSArray *assets = PNURelease(data, repository);
            dispatch_async(dispatch_get_main_queue(), ^{
                PNUBridge *owner = weakSelf;
                if (!owner || owner.destroyed || !owner.active || owner.operation != operation) return;
                if (owner.cancelling) { [owner finish:4 error:0 version:nil]; return; }
                if (!assets) { [owner finish:3 error:PNUIdentity version:nil]; return; }
                owner.archive = assets[1];
                [owner fetch:assets[0] resolving:YES];
            });
        });
    }
}

- (void)startProbe {
    if (!self.updater) {
        self.updater = [[SPUUpdater alloc] initWithHostBundle:self.host applicationBundle:self.host userDriver:self delegate:self];
        // Own distinct bundle defaults only. Never resume a persisted automatic install policy.
        self.updater.automaticallyChecksForUpdates = NO;
        self.updater.automaticallyDownloadsUpdates = NO;
        self.updater.sendsSystemProfile = NO;
        NSError *error = nil;
        if (![self.updater startUpdater:&error]) { [self finish:3 error:PNUNative version:nil]; return; }
    }
    [self.updater checkForUpdates];
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feed.absoluteString; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater { return [NSSet setWithObject:@"desktop-stable"]; }
- (BOOL)updater:(SPUUpdater *)updater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    BOOL allowed = self.active && !self.cancelling && PNUCDN(self.feed) && self.archive;
    if (!allowed && error) *error = [NSError errorWithDomain:@"PilotNextUpdater" code:PNUIdentity userInfo:nil];
    return allowed;
}
- (int32_t)validateItem:(SUAppcastItem *)item {
    if (![item.fileURL isEqual:self.archive] || item.deltaUpdates.count || item.isDeltaUpdate ||
        ![item.channel isEqual:@"desktop-stable"] || ![item.osString isEqual:@"macos"] ||
        item.informationOnlyUpdate || ![item.installationType isEqual:@"application"]) return PNUIdentity;
    if (!PNUVersionString(item.versionString) ||
        [SUStandardVersionComparator.defaultComparator compareVersion:item.versionString toVersion:self.host.infoDictionary[@"CFBundleVersion"]] != NSOrderedDescending) return PNUVersion;
    NSDictionary *enclosure = item.propertiesDictionary[@"enclosure"];
    if (!PNUBase64(enclosure[@"sparkle:edSignature"], 64)) return PNUSignature;
    return 0; // Shape only. Sparkle verifies cryptographic trust only on archive download.
}
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    int32_t code = [self validateItem:item];
    if (code && error) *error = [NSError errorWithDomain:@"PilotNextUpdater" code:code userInfo:nil];
    return !code;
}
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    if (self.pending.kind) { [self finish:self.pending.kind error:self.pending.error version:[NSString stringWithUTF8String:self.pending.version]]; return; }
    int32_t code = PNUNative;
    if ([error.domain isEqual:SUSparkleErrorDomain] && error.code == SUNoUpdateError) { [self finish:1 error:0 version:nil]; return; }
    if ([error.domain isEqual:@"PilotNextUpdater"]) code = (int32_t)error.code;
    else if ([error.domain isEqual:NSURLErrorDomain]) code = PNUOffline;
    [self finish:3 error:code version:nil];
}

// Custom user driver is intentionally probe-only. It cannot start an archive download.
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO automaticUpdateDownloading:@NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
    self.cancellation = cancellation;
    if (self.cancelling) cancellation();
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    int32_t error = [self validateItem:item];
    if (state.stage != SPUUserUpdateStageNotDownloaded) error = PNUIdentity;
    PNUEvent pending = { .kind = error ? 3 : 2, .error = error };
    if (!error) [item.versionString getCString:pending.version maxLength:sizeof(pending.version) encoding:NSUTF8StringEncoding];
    self.pending = pending;
    // Skip cancels any unexpected cached prepared installer. Dismiss is safe only before download.
    reply(state.stage == SPUUserUpdateStageNotDownloaded ? SPUUserUpdateChoiceDismiss : SPUUserUpdateChoiceSkip);
}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack { self.pending = (PNUEvent){ .kind = 1 }; ack(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack { ack(); }
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { cancellation(); }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length {}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {}
- (void)showDownloadDidStartExtractingUpdate {}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply { reply(SPUUserUpdateChoiceSkip); }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack { ack(); }
- (void)dismissUpdateInstallation { self.cancellation = nil; }
@end

bool pnu_is_main_thread(void) { return NSThread.isMainThread; }
void *pnu_create(const char *expected_bundle_id, PNUWake wake, void *context) {
    if (!NSThread.isMainThread || !expected_bundle_id) return NULL;
#if !defined(__arm64__)
    return NULL;
#endif
    NSBundle *host = NSBundle.mainBundle;
    if (!PNUHost(host, [NSString stringWithUTF8String:expected_bundle_id])) return NULL;
    PNUBridge *bridge = [PNUBridge new]; bridge.host = host;
    bridge.repository = host.infoDictionary[@"PilotNextUpdateRepository"];
    bridge.wake = wake; bridge.wakeContext = context;
    return (__bridge_retained void *)bridge;
}
int32_t pnu_check(void *handle, uint64_t operation, const char *token) {
    NSCAssert(NSThread.isMainThread, @"main thread");
    return [(__bridge PNUBridge *)handle begin:operation token:token ? [NSString stringWithUTF8String:token] : nil];
}
void pnu_cancel(void *handle, uint64_t operation) {
    NSCAssert(NSThread.isMainThread, @"main thread");
    PNUBridge *bridge = (__bridge PNUBridge *)handle;
    if (!bridge.active || bridge.operation != operation) return;
    bridge.cancelling = YES;
    if (bridge.task) [bridge.task cancel];
    else if (bridge.cancellation) {
        void (^cancellation)(void) = bridge.cancellation;
        bridge.cancellation = nil;
        cancellation();
    }
    // During off-main JSON decode the generation-fenced completion acknowledges cancellation.
}
bool pnu_take_event(void *handle, PNUEvent *event) {
    NSCAssert(NSThread.isMainThread, @"main thread");
    PNUBridge *bridge = (__bridge PNUBridge *)handle;
    if (!bridge.event.kind) return false;
    *event = bridge.event; bridge.event = (PNUEvent){0}; return true;
}
void pnu_destroy(void *handle) {
    NSCAssert(NSThread.isMainThread, @"main thread");
    PNUBridge *bridge = (__bridge_transfer PNUBridge *)handle;
    bridge.destroyed = YES;
    bridge.wake = NULL; bridge.wakeContext = NULL;
    if (bridge.cancellation) bridge.cancellation();
    bridge.cancellation = nil; bridge.token = nil;
    [bridge.session invalidateAndCancel]; bridge.session = nil;
    bridge.updater = nil;
}
