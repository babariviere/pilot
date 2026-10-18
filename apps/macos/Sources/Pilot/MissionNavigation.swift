import PilotCore

extension AppModel {
    func missionAvailable(_ reference: HostResourceRef) -> Bool {
        reference.host == localHost ? client.connected : hosts.available.contains(reference.host)
    }

    /// Canonical mission identity is independent of chat/task execution and the selected project.
    func openLogicalMission(_ mission: ControlLogicalMission, tab: MissionTab? = nil) {
        openMission(missionRegistry.destination(mission, model: self).storageKey, tab: tab)
    }

    var selectedLogicalMission: ControlLogicalMission? {
        guard let id = selectedMissionId, let reference = resourceRef(id, kind: .mission) else { return nil }
        return missionRegistry.row(for: reference)
    }

    var currentMissionReference: HostResourceRef? {
        if let id = selectedMissionId, let reference = resourceRef(id, kind: .mission) {
            return missionRegistry.row(for: reference).map { missionRegistry.destination($0, model: self) } ?? reference
        }
        guard let session = selectedSession, let missionId = session.missionId else { return nil }
        let context = hosts.selection.map { HostViewContext(host: $0.host, hosts: hosts) }
        return resourceRef(missionId, kind: .mission, context: context)
    }

    var currentMission: Mission? {
        guard let reference = currentMissionReference else { return client.mission(currentMissionId) }
        if reference.host == localHost { return client.mission(reference.localId) }
        return hosts.missions.first { $0.ref == reference }?.value
    }
}
