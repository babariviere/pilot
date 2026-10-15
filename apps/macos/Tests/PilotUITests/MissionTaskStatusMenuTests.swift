import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test @MainActor func taskStatusMenusIncludeEveryStatusIcon() throws {
    guard #available(macOS 14.4, *) else { return }
    _ = NSApplication.shared
    // NSMenuItem.image is not a reliable inspection on every SwiftUI runtime. Calibrate it against
    // an ordinary Apple label; the image-payload test below runs independently on every runtime.
    let baseline = NSHostingMenu(rootView: Button {} label: { Label("Baseline", systemImage: "circle") })
    baseline.update()
    let baselineItem = try #require(baseline.items.first)
    let exposesImages = baselineItem.image != nil
    print("Native status menu image inspection: \(exposesImages), baseline view: \(String(describing: baselineItem.view))")
    for selected in MissionTaskStatus.allCases {
        let content = MissionTaskStatusMenuItems(selected: selected) { _ in }
        let inline = NSHostingMenu(rootView: content)
        inline.update()
        let contextual = NSHostingMenu(rootView: Menu("Status") { content })
        contextual.update()
        let parent = try #require(contextual.items.first)
        let submenu = try #require(parent.submenu)
        submenu.update()
        for menu in [inline as NSMenu, submenu] {
            #expect(menu.items.map(\.title) == MissionTaskStatus.allCases.map(\.label))
            for (item, status) in zip(menu.items, MissionTaskStatus.allCases) {
                if exposesImages {
                    #expect(item.image != nil, "Missing native menu icon for \(status.label)")
                }
                #expect(item.isEnabled == (status != selected))
            }
        }
    }
}

@Test @MainActor func taskStatusMenuImagesAreNativeTemplates() throws {
    for status in MissionTaskStatus.allCases {
        let image = status.icon.menuImage
        #expect(image.isTemplate)
        #expect(image.size.width > 0 && image.size.height > 0)
        let tiff = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiff))
        var visible = false
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 { visible = true }
            }
        }
        #expect(visible, "Empty native menu image for \(status.label)")
    }
}
