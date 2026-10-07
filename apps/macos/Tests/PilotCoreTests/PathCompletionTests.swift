import Foundation
import Testing
@testable import PilotCore

private func completions(_ text: String, directory: String) -> [String] {
    guard let range = PathCompletion.range(in: text, selection: NSRange(location: (text as NSString).length, length: 0)) else { return [] }
    return PathCompletion.candidates(in: text, range: range, directory: directory)
}

private func withCompletionDirectory(_ body: (URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for folder in ["Sources", "Spaces here", ".hidden"] {
        try FileManager.default.createDirectory(at: directory.appendingPathComponent(folder), withIntermediateDirectories: false)
    }
    for file in ["README.md", "Report.txt", "café🎨.swift", "Sources/main.swift"] {
        try Data().write(to: directory.appendingPathComponent(file))
    }
    try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("linked"), withDestinationURL: directory.appendingPathComponent("Sources"))
    try body(directory)
}

@Test func completesRelativePathsAndDirectories() throws {
    try withCompletionDirectory { directory in
        #expect(completions("Read R", directory: directory.path) == ["README.md", "Report.txt"])
        #expect(completions("Edit Sou", directory: directory.path) == ["Sources/"])
        #expect(completions("Edit Sources/ma", directory: directory.path) == ["Sources/main.swift"])
        #expect(completions("./R", directory: directory.path) == ["./README.md", "./Report.txt"])
        #expect(completions("../R", directory: directory.appendingPathComponent("Sources").path) == ["../README.md", "../Report.txt"])
        #expect(completions("lin", directory: directory.path) == ["linked/"])
        #expect(completions("café🎨", directory: directory.path) == ["café🎨.swift"])
    }
}

@Test func completesAbsoluteAndHomePathsWithoutChangingTheirSpelling() throws {
    try withCompletionDirectory { directory in
        #expect(completions(directory.path + "/R", directory: "/") == [directory.path + "/README.md", directory.path + "/Report.txt"])
        #expect(completions("~", directory: directory.path) == ["~/"])
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let range = NSRange(location: 0, length: 2)
        let expected = PathCompletion.candidates(in: home + "/", range: NSRange(location: 0, length: (home as NSString).length + 1), directory: "/")
            .map { "~/" + $0.dropFirst(home.count + 1) }
        #expect(PathCompletion.candidates(in: "~/", range: range, directory: directory.path) == expected)
    }
}

@Test func completesQuotedAndEscapedSpaces() throws {
    try withCompletionDirectory { directory in
        #expect(completions("Edit Spa", directory: directory.path) == ["Spaces\\ here/"])
        #expect(completions("Edit Spaces\\ h", directory: directory.path) == ["Spaces\\ here/"])
        for quote in ["\"", "'", "`"] {
            #expect(completions("Edit " + quote + "Spaces h", directory: directory.path) == ["Spaces here/"])
        }
        #expect(completions("Edit 'Sources/ma", directory: directory.path) == ["Sources/main.swift"])
    }
}

@Test func pathCompletionHandlesMissingAndHiddenFiles() throws {
    try withCompletionDirectory { directory in
        #expect(completions("./", directory: directory.path).contains("./.hidden/") == false)
        #expect(completions(".h", directory: directory.path) == [".hidden/"])
        #expect(completions("missing/", directory: directory.path).isEmpty)
        #expect(completions("nonsense", directory: directory.path).isEmpty)
        #expect(completions("https://example.com/S", directory: directory.path).isEmpty)
        #expect(completions("", directory: directory.path).isEmpty)
        #expect(completions("Edit ", directory: directory.path).isEmpty)
    }
}

@Test func completionRangesPreserveSurroundingTextAndUTF16Offsets() {
    let message = "🎨 Edit\n`Sources/ma` later"
    let source = message as NSString
    let caret = source.range(of: "` later").location
    let range = PathCompletion.range(in: message, selection: NSRange(location: caret, length: 0))
    #expect(range == source.range(of: "Sources/ma"))
    #expect(PathCompletion.range(in: message, selection: NSRange(location: caret, length: 2)) == nil)
    #expect(PathCompletion.range(in: "README.md", selection: NSRange(location: 3, length: 0)) == nil)
    #expect(PathCompletion.range(in: "'README.md'", selection: NSRange(location: 4, length: 0)) == nil)
    #expect(PathCompletion.range(in: message, selection: NSRange(location: NSNotFound, length: 0)) == nil)
    #expect(PathCompletion.range(in: "'Sources' ", selection: NSRange(location: 10, length: 0)) == nil)
    #expect(PathCompletion.candidates(in: "a", range: NSRange(location: NSNotFound, length: 1), directory: "/").isEmpty)
}
