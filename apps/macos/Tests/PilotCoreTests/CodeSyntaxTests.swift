import Testing
@testable import PilotCore

@Test func highlightsCodemodeJavaScript() {
    let source = "// Run tools\nconst result = await tools.bash({ command: \"echo hello\", timeout: 30 });\ntext(result);"
    let tokens = CodeSyntax.tokens(source, language: "javascript")
    #expect(tokens.map(\.text).joined() == source)
    #expect(tokens.contains(.init(text: "// Run tools", kind: .comment)))
    #expect(tokens.contains(.init(text: "const", kind: .keyword)))
    #expect(tokens.contains(.init(text: "await", kind: .keyword)))
    #expect(tokens.contains(.init(text: "bash", kind: .function)))
    #expect(tokens.contains(.init(text: "text", kind: .function)))
    #expect(tokens.contains(.init(text: "\"echo hello\"", kind: .string)))
    #expect(tokens.contains(.init(text: "30", kind: .number)))
    #expect(tokens.contains(.init(text: "result", kind: nil)))
}

@Test func supportsJavaScriptAndTypeScriptAliases() {
    for language in ["javascript", "js", "mjs", "cjs", "typescript", "ts", " JavaScript\n"] {
        let tokens = CodeSyntax.tokens("const enabled = true;", language: language)
        #expect(tokens.contains(.init(text: "const", kind: .keyword)))
        #expect(tokens.contains(.init(text: "true", kind: .literal)))
    }
    let tokens = CodeSyntax.tokens("interface Item { readonly name: string }", language: "ts")
    #expect(tokens.contains(.init(text: "interface", kind: .keyword)))
    #expect(tokens.contains(.init(text: "readonly", kind: .keyword)))
}

@Test func leavesUnknownLanguagesAndToolOutputPlain() {
    let source = "const true = 'hello'; // not necessarily JavaScript"
    for language: String? in [nil, "", "arguments", "python", "shell"] {
        #expect(CodeSyntax.tokens(source, language: language) == [.init(text: source, kind: nil)])
    }
}

@Test func stringsAndCommentsProtectTheirContents() {
    let source = #"""
    /* await "quoted"
       const 42 */
    const url = "https://example.com/\"return\"";
    const single = 'it\'s true';
    const template = `hello
    ${await tools.read()} // text`;
    // return 'false' 123
    """#
    let tokens = CodeSyntax.tokens(source, language: "js")
    #expect(tokens.map(\.text).joined() == source)
    #expect(tokens.filter { $0.kind == .comment }.count == 2)
    #expect(tokens.filter { $0.kind == .string }.count == 3)
    #expect(tokens.filter { $0.kind == .keyword }.map(\.text) == ["const", "const", "const"])
    #expect(!tokens.contains { $0.kind == .number || $0.kind == .literal })
}

@Test func highlightsNumericLiteralsAndFunctionNames() {
    let source = "const n = [0xff, 0b101n, 0o755, 1_000, 42n, .5, 1.2e-3]; function run () { return null; }"
    let tokens = CodeSyntax.tokens(source, language: "js")
    #expect(tokens.map(\.text).joined() == source)
    #expect(tokens.filter { $0.kind == .number }.map(\.text) == ["0xff", "0b101n", "0o755", "1_000", "42n", ".5", "1.2e-3"])
    #expect(tokens.contains(.init(text: "run", kind: .function)))
    #expect(tokens.contains(.init(text: "null", kind: .literal)))
    #expect(tokens.contains(.init(text: "function", kind: .keyword)))
}

@Test func preservesUnicodeWhitespaceAndIncompleteCode() {
    for source in [
        "", "\t \r\n", "const café = '🎨';\r\n\ttext(café);\n",
        "/* const 42", "// comment", "\"await true", "'const 12", "`hello\nawait 12",
        "\"unfinished\\", "'unfinished\\", "`unfinished\\",
    ] {
        let tokens = CodeSyntax.tokens(source, language: "js")
        #expect(tokens.map(\.text).joined() == source)
        if source.hasPrefix("/*") || source.hasPrefix("//") {
            #expect(tokens == [.init(text: source, kind: .comment)])
        } else if source.hasPrefix("\"") || source.hasPrefix("'") || source.hasPrefix("`") {
            #expect(tokens == [.init(text: source, kind: .string)])
        }
    }
}

@Test func markdownJavaScriptFencesUseTheSameHighlighting() {
    let blocks = Markdown.parse("```javascript\nawait tools.read({ path: 'hello' });\n```")
    guard case let .code(language, source) = blocks.first else {
        Issue.record("Expected a code block")
        return
    }
    #expect(CodeSyntax.tokens(source, language: language).contains(.init(text: "await", kind: .keyword)))
}
