// Compare status clocks without a daemon or the user's settings. Run from the repository root:
// xcrun swiftc -O -parse-as-library apps/macos/scripts/bench-status.swift \
//   apps/macos/Sources/Pilot/BrailleProgress.swift -o /tmp/pilot-status-bench
// /tmp/pilot-status-bench --animation  # Previous display-linked schedule.
// /tmp/pilot-status-bench              # Current periodic schedule.
// Reports process CPU over eight seconds after a two-second warmup. No timing assertions.
import AppKit
import Darwin
import SwiftUI

private struct StatusBenchView: View {
    let animation: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(0..<12) { index in
                HStack {
                    if animation {
                        TimelineView(.animation(minimumInterval: BrailleProgress.interval)) { context in
                            Image(nsImage: BrailleProgress.images[BrailleProgress.frameIndex(at: context.date)])
                        }
                    } else {
                        TimelineView(.periodic(from: .now, by: BrailleProgress.interval)) { context in
                            Image(nsImage: BrailleProgress.images[BrailleProgress.frameIndex(at: context.date)])
                        }
                    }
                    Text("Working session \(index)")
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

@main private enum StatusBench {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 440),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: StatusBenchView(animation: CommandLine.arguments.contains("--animation")))
        window.orderFrontRegardless()
        Task { @MainActor in
            do { try await Task.sleep(for: .seconds(2)) } catch { exit(1) }
            var start = rusage()
            getrusage(RUSAGE_SELF, &start)
            let clock = ContinuousClock()
            let began = clock.now
            do { try await Task.sleep(for: .seconds(8)) } catch { exit(1) }
            let elapsed = began.duration(to: clock.now).components
            let wallSeconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
            var end = rusage()
            getrusage(RUSAGE_SELF, &end)
            func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
            let cpu = seconds(end.ru_utime) + seconds(end.ru_stime) - seconds(start.ru_utime) - seconds(start.ru_stime)
            print("CPU: \(cpu / wallSeconds * 100)% of one core, peak RSS: \(Double(end.ru_maxrss) / 1048576) MiB")
            exit(0)
        }
        app.run()
        withExtendedLifetime(window) {}
    }
}
