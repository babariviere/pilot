import Foundation
import Testing
@testable import PilotCore

@Test func parsesUnifiedDiffWithLineNumbers() {
    let text = """
    diff --git a/src/a.ts b/src/a.ts
    index 1..2 100644
    --- a/src/a.ts
    +++ b/src/a.ts
    @@ -10,3 +10,3 @@ function f() {
     keep
    -old
    +new
     tail
    diff --git a/new.txt b/new.txt
    new file mode 100644
    --- /dev/null
    +++ b/new.txt
    @@ -0,0 +1 @@
    +fresh
    """
    let files = Diff.parseUnified(text)
    #expect(files.map(\.path) == ["src/a.ts", "new.txt"])
    #expect(files[0].additions == 1 && files[0].deletions == 1)
    #expect(files[0].lines[1] == DiffLine(kind: .context, text: "keep", oldNumber: 10, newNumber: 10))
    #expect(files[0].lines[3] == DiffLine(kind: .addition, text: "new", oldNumber: nil, newNumber: 11))
    #expect(files[1].lines.last?.text == "fresh")
}

@Test func parsesApplyPatch() {
    let files = Diff.parsePatch("*** Begin Patch\n*** Update File: a/b.ts\n@@ fn\n ctx\n-x\n+y\n*** Add File: c.md\n+hello\n*** End Patch")
    #expect(files.map(\.path) == ["a/b.ts", "c.md"])
    #expect(files[0].lines.map(\.kind) == [.hunk, .context, .deletion, .addition])
    #expect(files[1].additions == 1)
}

@Test func diffsEditsByLine() {
    let file = Diff.parseEdit(path: "x", old: "a\nb\nc", new: "a\nB\nc")
    #expect(file.lines.map(\.kind) == [.context, .deletion, .addition, .context])
}
