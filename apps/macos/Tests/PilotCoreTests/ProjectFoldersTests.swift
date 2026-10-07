import Foundation
import Testing
@testable import PilotCore

private func createFolder(_ model: inout ProjectFolders, name: String) throws -> ProjectFolder {
    let folder = model.create(name: name)
    return try #require(folder)
}

@Test func projectFoldersCreateTrimsNamesAndRejectsBlankNames() throws {
    var model = ProjectFolders()
    #expect(model.folders.isEmpty)
    #expect(model.assignments.isEmpty)
    #expect(model.collapsed.isEmpty)
    for name in ["", " ", "\t\n\r", "\u{2003}"] {
        #expect(model.create(name: name) == nil)
    }
    #expect(model.folders.isEmpty)

    let first = try createFolder(&model, name: " \n Work projects \t")
    let duplicate = try createFolder(&model, name: "Work projects")
    #expect(first.name == "Work projects")
    #expect(first.id != duplicate.id)
    #expect(UUID(uuidString: first.id) != nil)
    #expect(UUID(uuidString: duplicate.id) != nil)
    #expect(model.folders == [first, duplicate])
}

@Test func projectFoldersRenamePreservesIdentityAndMembership() throws {
    var model = ProjectFolders()
    let folder = try createFolder(&model, name: "Original")
    model.move(projectId: "project", to: folder.id)
    model.setExpanded(false, folderId: folder.id)
    model.rename(folder.id, name: " \t Renamed folder \n")
    #expect(model.folders == [ProjectFolder(id: folder.id, name: "Renamed folder")])
    #expect(model.folderId(for: "project") == folder.id)
    #expect(model.collapsed == [folder.id])

    let renamed = model
    for name in ["", " \t\n", "\u{2003}"] {
        model.rename(folder.id, name: name)
        #expect(model == renamed)
    }
    model.rename("missing", name: "Valid name")
    #expect(model == renamed)
}

@Test func projectFoldersMoveValidatesDestinationAndUngroups() throws {
    var model = ProjectFolders()
    let first = try createFolder(&model, name: "First")
    let second = try createFolder(&model, name: "Second")
    #expect(model.folderId(for: "project") == nil)
    model.move(projectId: "project", to: "missing")
    #expect(model.assignments.isEmpty)
    model.move(projectId: "project", to: first.id)
    #expect(model.folderId(for: "project") == first.id)
    model.move(projectId: "project", to: "missing")
    #expect(model.folderId(for: "project") == first.id)
    model.move(projectId: "project", to: second.id)
    #expect(model.assignments == ["project": second.id])
    model.move(projectId: "project", to: nil)
    model.move(projectId: "missing-project", to: nil)
    #expect(model.folderId(for: "project") == nil)
    #expect(model.assignments.isEmpty)
    #expect(model.folders == [first, second])
}

@Test func projectFoldersRemovalUngroupsAllMembersAndKeepsOtherFolders() throws {
    var model = ProjectFolders()
    let removed = try createFolder(&model, name: "Same name")
    let kept = try createFolder(&model, name: "Same name")
    model.move(projectId: "one", to: removed.id)
    model.move(projectId: "two", to: removed.id)
    model.move(projectId: "three", to: kept.id)
    model.setExpanded(false, folderId: removed.id)
    model.setExpanded(false, folderId: kept.id)
    model.remove(removed.id)
    #expect(model.folders == [kept])
    #expect(model.assignments == ["three": kept.id])
    #expect(model.folderId(for: "one") == nil)
    #expect(model.folderId(for: "two") == nil)
    #expect(model.folderId(for: "three") == kept.id)
    #expect(model.collapsed == [kept.id])
    let remaining = model
    model.remove("missing")
    model.remove(removed.id)
    #expect(model == remaining)
}

@Test func projectFoldersCollapseOnlyTracksExistingFolders() throws {
    var model = ProjectFolders()
    let folder = try createFolder(&model, name: "Folder")
    #expect(model.collapsed.isEmpty)
    model.setExpanded(false, folderId: "missing")
    #expect(model.collapsed.isEmpty)
    model.setExpanded(false, folderId: folder.id)
    model.setExpanded(false, folderId: folder.id)
    #expect(model.collapsed == [folder.id])
    model.setExpanded(true, folderId: "missing")
    #expect(model.collapsed == [folder.id])
    model.setExpanded(true, folderId: folder.id)
    model.setExpanded(true, folderId: folder.id)
    #expect(model.collapsed.isEmpty)
}

@Test func projectFoldersPersistenceRoundTrip() throws {
    let suite = "ProjectFoldersTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    var model = ProjectFolders()
    let first = try createFolder(&model, name: "First")
    let second = try createFolder(&model, name: "Second")
    model.rename(first.id, name: "Renamed")
    model.move(projectId: "one", to: first.id)
    model.move(projectId: "two", to: second.id)
    model.setExpanded(false, folderId: second.id)
    model.save(defaults: defaults)
    #expect(defaults.data(forKey: "PilotProjectFolders") != nil)
    #expect(ProjectFolders.load(defaults: defaults) == model)

    model.remove(first.id)
    model.setExpanded(true, folderId: second.id)
    model.save(defaults: defaults)
    #expect(ProjectFolders.load(defaults: defaults) == model)
    ProjectFolders().save(defaults: defaults)
    #expect(ProjectFolders.load(defaults: defaults) == ProjectFolders())
}

@Test func projectFoldersMissingOrCorruptDefaultsLoadEmpty() throws {
    let suite = "ProjectFoldersTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    #expect(ProjectFolders.load(defaults: defaults) == ProjectFolders())
    defaults.set("not data", forKey: "PilotProjectFolders")
    #expect(ProjectFolders.load(defaults: defaults) == ProjectFolders())
    for value in ["not JSON", "{}", "null", "{\"folders\":\"invalid\",\"assignments\":{},\"collapsed\":[]}"] {
        defaults.set(Data(value.utf8), forKey: "PilotProjectFolders")
        #expect(ProjectFolders.load(defaults: defaults) == ProjectFolders())
    }
}

@Test func projectFoldersLookupIgnoresDanglingAssignment() throws {
    let data = Data("{\"folders\":[],\"assignments\":{\"project\":\"missing\"},\"collapsed\":[]}".utf8)
    let model = try JSONDecoder().decode(ProjectFolders.self, from: data)
    #expect(model.assignments["project"] == "missing")
    #expect(model.folderId(for: "project") == nil)
}
