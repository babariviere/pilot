// Synthetic policy/transport/temp-bundle tests. Never starts Sparkle's installer.
// The bridge is included to exercise the real policy and NSURLSession delegate code.
#import "../native/bridge.m"
#include <assert.h>

static NSMutableArray<NSURLRequest *> *requests;
static int scenario;

static NSDictionary *release(void) {
    return @{@"draft": @NO, @"prerelease": @NO, @"tag_name": @"desktop-v0.1.1", @"assets": @[
        @{@"id": @11, @"name": @"appcast-desktop-macos-arm64.xml", @"state": @"uploaded"},
        @{@"id": @12, @"name": @"Pilot-Next-macos-arm64.zip", @"state": @"uploaded"}]};
}

@interface FauxProtocol : NSURLProtocol @end
@implementation FauxProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return YES; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
    assert(NSThread.isMainThread == NO); // NSURLSession transport work isn't on UI.
    @synchronized(requests) { [requests addObject:self.request]; }
    assert([self.request.URL.host isEqual:@"api.github.com"]);
    assert([[self.request valueForHTTPHeaderField:@"Authorization"] isEqual:@"Bearer synthetic-token"]);
    if (scenario == 1) {
        [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNotConnectedToInternet userInfo:nil]];
        return;
    }
    NSInteger status = 200; NSDictionary *headers = @{}; NSData *body = [NSJSONSerialization dataWithJSONObject:release() options:0 error:NULL];
    if (scenario == 2) status = 401;
    if (scenario == 3) { status = 302; headers = @{@"Location": @"https://evil.invalid/release"}; }
    if (scenario == 4) body = [NSMutableData dataWithLength:PNUMaxMetadata + 1];
    if (scenario == 5) body = [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
    if ([self.request.URL.path hasSuffix:@"/11"]) {
        status = 302;
        headers = @{@"Location": scenario == 6 ? @"https://evil.invalid/archive" : @"https://release-assets.githubusercontent.com/abc/feed?sig=synthetic"};
        body = NSData.data;
    }
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:headers];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [self.client URLProtocol:self didLoadData:body];
    [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end

@interface Probe : PNUBridge
@property NSUInteger probes;
@end
@implementation Probe
- (NSURLSessionConfiguration *)sessionConfiguration {
    NSURLSessionConfiguration *configuration = super.sessionConfiguration;
    configuration.protocolClasses = @[FauxProtocol.class];
    return configuration;
}
- (void)startProbe {
    self.probes++;
    assert(self.token == nil);
    assert(PNUCDN(self.feed));
    assert([self.archive.absoluteString isEqual:@"https://api.github.com/repos/owner/repo/releases/assets/12"]);
    [self finish:1 error:0 version:nil];
}
@end

static void spinUntil(BOOL (^finished)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!finished() && deadline.timeIntervalSinceNow > 0) {
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
    }
    assert(finished());
}

static NSBundle *temporaryBundle(NSURL *root, NSMutableDictionary *info) {
    NSURL *app = [root URLByAppendingPathComponent:NSUUID.UUID.UUIDString];
    app = [app URLByAppendingPathExtension:@"app"];
    NSURL *contents = [app URLByAppendingPathComponent:@"Contents"];
    assert([NSFileManager.defaultManager createDirectoryAtURL:contents withIntermediateDirectories:YES attributes:nil error:NULL]);
    assert([info writeToURL:[contents URLByAppendingPathComponent:@"Info.plist"] error:NULL]);
    return [NSBundle bundleWithURL:app];
}

int main(void) { @autoreleasepool {
    assert(NSThread.isMainThread);
    assert(PNURepository(@"owner/private-repo"));
    for (NSString *value in @[@"", @"owner/repo/extra", @"../repo", @"owner/%2f", @"owner/repo?x", @"o/."]) assert(!PNURepository(value));
    assert(PNUCDN([NSURL URLWithString:@"https://release-assets.githubusercontent.com/path?sig=x"]));
    for (NSString *value in @[@"http://release-assets.githubusercontent.com/path", @"https://release-assets.githubusercontent.com:443/path", @"https://release-assets.githubusercontent.com.evil.invalid/path", @"https://u:p@release-assets.githubusercontent.com/path", @"https://release-assets.githubusercontent.com/path#fragment", @"file:///tmp/x"]) assert(!PNUCDN([NSURL URLWithString:value]));
    for (NSString *value in @[@"", @"1a", @"-1", @"1..2", @"1.2.3.4.5", @"9999999999"]) assert(!PNUVersionString(value));
    assert(PNUVersionString(@"201.2"));
    assert(PNUBase64([[NSMutableData dataWithLength:32] base64EncodedStringWithOptions:0], 32));
    assert(!PNUBase64(@"invalid", 32));
    assert(PNUAsset(@"owner/repo", @12));
    for (NSNumber *value in @[@YES, @0, @-1, @1.5]) assert(!PNUAsset(@"owner/repo", value));

    NSData *metadata = [NSJSONSerialization dataWithJSONObject:release() options:0 error:NULL];
    assert(PNURelease(metadata, @"owner/repo").count == 2);
    for (NSString *field in @[@"draft", @"prerelease", @"tag_name", @"assets"]) {
        NSMutableDictionary *bad = [release() mutableCopy]; [bad removeObjectForKey:field];
        assert(!PNURelease([NSJSONSerialization dataWithJSONObject:bad options:0 error:NULL], @"owner/repo"));
    }
    NSMutableDictionary *bad = [release() mutableCopy]; bad[@"assets"] = [release()[@"assets"] arrayByAddingObject:release()[@"assets"][0]];
    assert(!PNURelease([NSJSONSerialization dataWithJSONObject:bad options:0 error:NULL], @"owner/repo"));
    bad = [release() mutableCopy]; bad[@"tag_name"] = @"v0.1.1";
    assert(!PNURelease([NSJSONSerialization dataWithJSONObject:bad options:0 error:NULL], @"owner/repo"));

    NSURL *root = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString] isDirectory:YES];
    NSMutableDictionary *info = [@{@"CFBundleIdentifier": @"com.example.synthetic.next", @"CFBundleVersion": @"100.1", @"CFBundlePackageType": @"APPL",
        @"PilotNextUpdaterIdentity": @"rust-macos-v1", @"PilotNextUpdateRepository": @"owner/repo", @"PilotNextUpdateChannel": @"desktop-stable",
        @"SUPublicEDKey": [[NSMutableData dataWithLength:32] base64EncodedStringWithOptions:0],
        @"SUEnableAutomaticChecks": @NO, @"SUAllowsAutomaticUpdates": @NO, @"SUAutomaticallyUpdate": @NO} mutableCopy];
    NSBundle *host = temporaryBundle(root, info);
    assert(PNUHost(host, @"com.example.synthetic.next"));
    assert(!PNUHost(host, @"com.babariviere.pilot"));
    assert(!PNUHost(host, @"com.example.other"));
    for (NSString *field in @[@"PilotNextUpdaterIdentity", @"PilotNextUpdateChannel", @"SUPublicEDKey", @"PilotNextUpdateRepository", @"SUAllowsAutomaticUpdates"]) {
        NSMutableDictionary *missing = [info mutableCopy]; [missing removeObjectForKey:field];
        assert(!PNUHost(temporaryBundle(root, missing), @"com.example.synthetic.next"));
    }

    // Test real Sparkle appcast-item interpretation, not a parallel hand-written parser.
    PNUBridge *policy = [PNUBridge new]; policy.host = host; policy.archive = PNUAsset(@"owner/repo", @12);
    NSMutableDictionary *enclosure = [@{@"url": policy.archive.absoluteString, @"sparkle:version": @"101.1", @"sparkle:os": @"macos",
        @"sparkle:edSignature": [[NSMutableData dataWithLength:64] base64EncodedStringWithOptions:0], @"length": @"12"} mutableCopy];
    NSDictionary *(^itemDictionary)(void) = ^{ return @{@"enclosure": enclosure, @"sparkle:channel": @"desktop-stable"}; };
    SUAppcastItem *(^item)(void) = ^{ return [[SUAppcastItem alloc] initWithDictionary:itemDictionary()]; };
    assert([policy validateItem:item()] == 0); // Signature presence/shape, NOT cryptographic validation.
    enclosure[@"sparkle:version"] = @"99.1"; assert([policy validateItem:item()] == PNUVersion);
    enclosure[@"sparkle:version"] = @"100.1"; assert([policy validateItem:item()] == PNUVersion);
    enclosure[@"sparkle:version"] = @"101.1"; enclosure[@"url"] = @"https://evil.invalid/archive"; assert([policy validateItem:item()] == PNUIdentity);
    enclosure[@"url"] = policy.archive.absoluteString; enclosure[@"sparkle:os"] = @"windows"; assert([policy validateItem:item()] == PNUIdentity);
    enclosure[@"sparkle:os"] = @"macos"; enclosure[@"sparkle:edSignature"] = @"invalid"; assert([policy validateItem:item()] == PNUSignature);

    requests = [NSMutableArray array];
    for (scenario = 0; scenario <= 6; scenario++) {
        [requests removeAllObjects];
        Probe *probe = [Probe new]; probe.repository = @"owner/repo";
        assert([probe begin:23 token:@"synthetic-token"] == 0);
        assert([probe begin:24 token:@"synthetic-token"] == PNUBusy);
        spinUntil(^BOOL { return probe.event.kind != 0; });
        assert(probe.event.operation == 23);
        if (scenario == 0) { assert(probe.event.kind == 1); assert(probe.probes == 1); assert(requests.count == 2); }
        else {
            assert(probe.event.kind == 3); assert(probe.probes == 0);
            int expected[] = {0, PNUOffline, PNUAuth, PNURedirect, PNUResponse, PNUIdentity, PNURedirect};
            assert(probe.event.error == expected[scenario]);
        }
        assert(probe.token == nil); assert(probe.session == nil);
        [probe.session invalidateAndCancel];
    }
    scenario = 0;
    Probe *cancelled = [Probe new]; cancelled.repository = @"owner/repo";
    assert([cancelled begin:42 token:@"synthetic-token"] == 0);
    pnu_cancel((__bridge void *)cancelled, 41); assert(!cancelled.cancelling);
    pnu_cancel((__bridge void *)cancelled, 42);
    spinUntil(^BOOL { return cancelled.event.kind != 0; });
    assert(cancelled.event.kind == 4); assert(cancelled.probes == 0);
    assert(pnu_create("com.example.synthetic.next", NULL, NULL) == NULL); // unbundled test binary
    assert([NSFileManager.defaultManager removeItemAtURL:root error:NULL]);
    puts("native updater: synthetic transport/policy/temp-bundle checks passed; no real feed or install");
} return 0; }
