import PilotCore

/// Window-local, bounded history. It retains destinations, never views, feeds or drafts.
struct NavigationHistory<Location: Equatable> {
    private(set) var entries: [Location]
    private(set) var index = 0
    let limit: Int

    init(_ initial: Location, limit: Int = 100) {
        entries = [initial]
        self.limit = max(2, limit)
    }

    var canGoBack: Bool { index > 0 }
    var canGoForward: Bool { index + 1 < entries.count }
    var current: Location { entries[index] }

    mutating func record(_ location: Location) {
        guard entries[index] != location else { return }
        entries.removeSubrange((index + 1)..<entries.count)
        entries.append(location)
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
        index = entries.count - 1
    }

    /// Removed resources are skipped, not reinterpreted as another host's same-named resource.
    mutating func move(_ offset: Int, accepting: (Location) -> Bool) -> Location? {
        precondition(offset == -1 || offset == 1)
        while entries.indices.contains(index + offset) {
            let candidate = index + offset
            if accepting(entries[candidate]) {
                index = candidate
                return entries[index]
            }
            entries.remove(at: candidate)
            if candidate < index { index -= 1 }
        }
        return nil
    }
}

struct NavigationLocation: Equatable {
    enum ProjectPage: Equatable {
        case overview
        case memory
        case slack(caseId: String?)
    }

    var scope: String?
    var selection: SidebarSelection = .home
    var projectPage: ProjectPage = .overview
    /// Inbox and archive have an independent host and filter, not the current chat's host.
    var filterHost: HostRef?
    var inboxProjectId: String?
}
