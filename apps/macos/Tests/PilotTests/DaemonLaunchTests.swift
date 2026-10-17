import Foundation
import Testing
@testable import Pilot

@Test @MainActor func daemonLaunchUsesAbsoluteSourcesAndStableWorkingDirectory() throws {
    let home = URL(filePath: "/Users/pilot user")
    let log = home.appending(path: "Library/Logs/Pilot/pilotd.log")
    let environment = ["PATH": "/usr/bin:/bin", "PILOT_HOME": "/tmp/pilot-data", "PILOT_PORT": "4320"]
    // Both the bundled runtime and a PILOT_REPO development checkout use the same definition.
    for runtime in ["/Applications/Pilot.app/Contents/Resources/runtime", "/tmp/Pilot checkout"] {
        let daemon = URL(filePath: runtime).appending(path: "packages/daemon")
        let node = URL(filePath: runtime).appending(path: "node/bin/node").path
        let definition = DaemonController.launchAgentDefinition(node: node, daemonDirectory: daemon, home: home,
                                                               logURL: log, environment: environment)
        let data = try PropertyListSerialization.data(fromPropertyList: definition, format: .xml, options: 0)
        let saved = try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        #expect(saved["Label"] as? String == DaemonController.label)
        #expect(saved["ProgramArguments"] as? [String] == [node, daemon.appending(path: "src/main.ts").path])
        #expect(saved["WorkingDirectory"] as? String == home.path)
        #expect(saved["EnvironmentVariables"] as? [String: String] == environment)
        #expect(saved["StandardOutPath"] as? String == log.path)
        #expect(saved["StandardErrorPath"] as? String == log.path)
        #expect(saved["KeepAlive"] as? Bool == true)
        #expect(saved["ProcessType"] as? String == "Interactive")
    }
}

@Test @MainActor func daemonLaunchKeepsCwdAfterOldBundleIsRemoved() throws {
    let files = FileManager.default
    let root = files.temporaryDirectory.appending(path: "pilot launch \(UUID().uuidString)")
    defer { try? files.removeItem(at: root) }
    let home = root.appending(path: "home")
    let bundle = root.appending(path: "Pilot.app")
    let oldBundle = root.appending(path: "old Pilot.app")
    let daemon = bundle.appending(path: "Contents/Resources/runtime/packages/daemon")
    let entry = daemon.appending(path: "src/main.ts")
    try files.createDirectory(at: home, withIntermediateDirectories: true)
    try files.createDirectory(at: entry.deletingLastPathComponent(), withIntermediateDirectories: true)
    // A shell stands in for Node. Move and remove only this fixture's old bundle, then ask the
    // OS for the process cwd (not the shell's cached PWD). No launchd or user daemon is touched.
    try Data("/bin/mv \"$1\" \"$2\" && /bin/rm -rf \"$2\" && /bin/pwd -P\n".utf8).write(to: entry)
    let definition = DaemonController.launchAgentDefinition(node: "/bin/sh", daemonDirectory: daemon, home: home,
                                                           logURL: root.appending(path: "log"), environment: [:])
    let arguments = try #require(definition["ProgramArguments"] as? [String])
    let process = Process()
    process.executableURL = URL(filePath: try #require(arguments.first))
    process.arguments = Array(arguments.dropFirst()) + [bundle.path, oldBundle.path]
    process.currentDirectoryURL = URL(filePath: try #require(definition["WorkingDirectory"] as? String))
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    try process.run()
    process.waitUntilExit()
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    #expect(process.terminationStatus == 0, "\(text)")
    #expect(text.trimmingCharacters(in: .whitespacesAndNewlines) == home.resolvingSymlinksInPath().path)
    #expect(!files.fileExists(atPath: bundle.path))
    #expect(!files.fileExists(atPath: oldBundle.path))
}
