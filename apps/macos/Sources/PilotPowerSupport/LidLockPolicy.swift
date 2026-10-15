/// Request one lock per lid closure while Pilot owns the sleep override. Repeated sensor reports,
/// work starting/stopping, and unlocking at a dock must not continually relock the session.
public struct LidLockPolicy {
    private var requested = false

    public init() {}

    public mutating func shouldLock(lidClosed: Bool?, overrideActive: Bool) -> Bool {
        // Unknown lid state is not proof that the lid opened.
        if lidClosed == false { requested = false }
        guard lidClosed == true, overrideActive, !requested else { return false }
        requested = true
        return true
    }
}
