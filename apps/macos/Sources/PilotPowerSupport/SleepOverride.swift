import Foundation

/// The override is global and persistent. A marker records ownership BEFORE pmset, including uncertain writes.
/// The caller holds the per-user flock for this marker's entire lifetime. Never clear another app's override.
public final class SleepOverride {
    private var confirmed = false
    private let marker: URL
    private let readDisabled: () -> Bool?
    private let writeDisabled: (Bool) -> Bool

    public init(marker: URL, readDisabled: @escaping () -> Bool?, writeDisabled: @escaping (Bool) -> Bool) {
        self.marker = marker
        self.readDisabled = readDisabled
        self.writeDisabled = writeDisabled
    }

    public var ownsOverride: Bool { FileManager.default.fileExists(atPath: marker.path) }

    public func setEnabled(_ enabled: Bool) -> Bool {
        if !enabled {
            guard ownsOverride else { return true }
            guard writeDisabled(false) else { return false }
            confirmed = false
            do { try FileManager.default.removeItem(at: marker); return true } catch { return false }
        }
        if ownsOverride {
            if confirmed { return true }
            confirmed = writeDisabled(true)
            return confirmed
        }
        // Refuse to take over an existing override (for example another keep-awake app).
        guard readDisabled() == false else { return false }
        do {
            try Data("owned\n".utf8).write(to: marker, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
        } catch { return false }
        confirmed = writeDisabled(true)
        return confirmed
    }
}

public enum PowerPermission {
    public static let rulePath = "/etc/sudoers.d/pilot-power"
    public static func rule(uid: UInt32) -> String {
        "#\(uid) ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0"
    }
    /// Only a numeric uid and fixed paths enter the shell. Validate a root-owned temporary file before install.
    public static func installScript(uid: UInt32) -> String {
        "set -eu; /bin/mkdir -p /etc/sudoers.d; " +
        "tmp=$(/usr/bin/mktemp /etc/sudoers.d/.pilot-power.XXXXXX); trap '/bin/rm -f \"$tmp\"' EXIT; " +
        "/usr/bin/printf '%s\\n' '\(rule(uid: uid))' > \"$tmp\"; " +
        "/usr/sbin/chown root:wheel \"$tmp\"; /bin/chmod 0440 \"$tmp\"; " +
        "/usr/sbin/visudo -c -f \"$tmp\"; /bin/mv -f \"$tmp\" \(rulePath)"
    }
}
