import Foundation

extension PilotClient {
    /// Historical starts include archived chats, even when their workspace has been reclaimed.
    func activityDays(now: Date = Date(), calendar: Calendar = .current) -> [(label: String, count: Int)] {
        let today = calendar.startOfDay(for: now)
        let first = calendar.date(byAdding: .day, value: -13, to: today)!
        let days = (0 ... 14).map { calendar.date(byAdding: .day, value: $0, to: first)! }
        let boundaries = days.map { $0.timeIntervalSince1970 * 1000 }
        var counts = Array(repeating: 0, count: 14)
        // Resolve calendar boundaries once, then bucket each start without per-session calendar work.
        for session in sessions {
            let created = session.createdAt
            guard created >= boundaries[0], created < boundaries[14] else { continue }
            var lower = 0
            var upper = 14
            while lower + 1 < upper {
                let middle = (lower + upper) / 2
                if created >= boundaries[middle] { lower = middle } else { upper = middle }
            }
            counts[lower] += 1
        }
        let symbols = calendar.veryShortWeekdaySymbols
        return (0 ..< 14).map { offset in
            return (symbols[calendar.component(.weekday, from: days[offset]) - 1], counts[offset])
        }
    }
}
