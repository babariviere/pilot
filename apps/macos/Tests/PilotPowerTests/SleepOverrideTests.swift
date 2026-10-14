import Foundation
import PilotPowerSupport
import Testing

struct SleepOverrideTests {
    @Test func ownershipPrecedesWriteAndRestores() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let marker = directory.appendingPathComponent("override")
        var writes: [Bool] = []
        let override = SleepOverride(marker: marker, readDisabled: { false }, writeDisabled: { on in
            #expect(FileManager.default.fileExists(atPath: marker.path))
            writes.append(on)
            return true
        })
        #expect(override.setEnabled(true))
        #expect(override.setEnabled(true))
        #expect(override.setEnabled(false))
        #expect(!override.ownsOverride)
        #expect(writes == [true, false])
    }

    @Test func externalOrUnknownOverrideIsNeverTakenOver() throws {
        for disabled: Bool? in [true, nil] {
            let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            var writes = 0
            let override = SleepOverride(marker: marker, readDisabled: { disabled }, writeDisabled: { _ in writes += 1; return true })
            #expect(!override.setEnabled(true))
            #expect(override.setEnabled(false))
            #expect(writes == 0)
            #expect(!override.ownsOverride)
        }
    }

    @Test func uncertainEnableAndFailedRestoreRemainRecoverable() throws {
        let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: marker) }
        let failed = SleepOverride(marker: marker, readDisabled: { false }, writeDisabled: { _ in false })
        #expect(!failed.setEnabled(true))
        #expect(failed.ownsOverride)
        #expect(!failed.setEnabled(false))
        #expect(failed.ownsOverride)
        var writes: [Bool] = []
        let recovery = SleepOverride(marker: marker, readDisabled: { nil }, writeDisabled: { writes.append($0); return true })
        #expect(recovery.setEnabled(false))
        #expect(writes == [false])
        #expect(!recovery.ownsOverride)
    }

    @Test func permissionIsLimitedToTwoFixedCommands() {
        #expect(PowerPermission.rule(uid: 501) == "#501 ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0")
        let script = PowerPermission.installScript(uid: 501)
        #expect(script.contains("/usr/sbin/visudo -c -f"))
        #expect(script.contains("/usr/sbin/chown root:wheel"))
        #expect(script.contains("/bin/chmod 0440"))
        #expect(script.contains(PowerPermission.rulePath))
        #expect(!script.contains("NOPASSWD: ALL"))
    }
}
