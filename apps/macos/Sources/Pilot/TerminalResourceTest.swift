import AppKit
import GhosttyTerminal

/// Packaging smoke test. No daemon, shell, user config or network is needed.
@MainActor
enum TerminalResourceTest {
    static func run() {
        func fail(_ message: String) -> Never {
            print("terminal-resource-test failed: \(message)")
            exit(1)
        }
        guard Bundle.main.bundleURL.pathExtension == "app",
              let resources = Bundle.main.resourceURL else { fail("requires a packaged app") }
        let bundle = resources.appending(path: "GhosttyKit_GhosttyTerminal.bundle")
        guard let bundleResources = Bundle(url: bundle)?.resourceURL else {
            fail("missing Ghostty resource bundle")
        }
        for (name, actual) in [("Ghostty", GhosttyRuntimeResources.directoryURL),
                               ("terminfo", GhosttyRuntimeResources.terminfoDirectoryURL)] {
            guard let actual,
                  actual.standardizedFileURL.path == bundleResources.appending(path: name).standardizedFileURL.path,
                  FileManager.default.fileExists(atPath: actual.path) else {
                fail("\(name) must load from this app, not a build checkout")
            }
        }
        // This is the initialization path that previously trapped on Bundle.module.
        let controller = TerminalController(configSource: .none)
        controller.tick()
        print("terminal-resource-test passed: packaged resources and terminal initialization")
        exit(0)
    }
}
