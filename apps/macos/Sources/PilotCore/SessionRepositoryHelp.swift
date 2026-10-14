import Foundation

/// Tooltip text for a chat row's repository state. List rows show no diff counts, so the file and line
/// counts, branch and lookup errors are read here instead.
public enum SessionRepositoryHelp {
    public static func text(summary: SessionChangeSummary?, branch: String?, error: String?) -> String? {
        var lines: [String] = []
        if let summary { lines.append(summary.helpText) }
        if let branch, !branch.isEmpty { lines.append("Branch: \(branch)") }
        if let error { lines.append("Git changes unavailable: \(error)") }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }
}
