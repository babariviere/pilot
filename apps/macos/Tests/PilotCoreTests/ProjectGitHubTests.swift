import PilotCore
import Testing

@Test func projectGitHubLinksOnlyOpenSafeRepositoryURLs() {
    for raw in ["https://github.com/octo/repo", "https://github.acme.test/team/private"] {
        #expect(ProjectGitHubRepository(url: raw).browserURL?.absoluteString == raw)
    }
    for raw in ["", "file:///tmp/repo", "javascript:alert(1)", "https://user:secret@github.com/o/r",
                "https://github.com/o/r?token=secret", "https://github.com/o/r#x", "https://github.com/o/r/pull/1"] {
        #expect(ProjectGitHubRepository(url: raw).browserURL == nil)
    }
}
