import Foundation

// Swift 6.2+ exits 0 if AppKit stops the async-main CF run loop, even with tests
// unfinished (swiftlang/swift#91716). Override the drain entry point only in the
// mounted-test binaries via their shared support target; Swift Testing still
// exits with its real result when complete.
@_cdecl("swift_task_asyncMainDrainQueue")
func pilotTestMainLoop() -> Never {
    while true { CFRunLoopRun() }
}
