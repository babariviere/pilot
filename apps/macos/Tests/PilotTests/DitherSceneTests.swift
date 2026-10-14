import AppKit
import Foundation
import Testing
@testable import Pilot

@Test func coastSceneShipsWithTheAppAndIsFoundBesideTheBinary() throws {
    let bundled = try #require(Bundle.module.url(forResource: DitherSceneRenderer.resource, withExtension: "png"))
    // Builds keep the resource bundle beside the binary; the lookup must find it without Bundle.module.
    let buildDirectory = try #require(Bundle(url: Bundle.module.bundleURL.deletingLastPathComponent()))
    #expect(DitherSceneRenderer.sourceURL(main: buildDirectory)?.standardizedFileURL == bundled.standardizedFileURL)
    #expect(DitherSceneRenderer.loadSource(url: nil) == nil)
}

@Test func coastSceneRendersAtTheRequestedSizeAndDissolvesAtItsFoot() throws {
    let url = try #require(Bundle.module.url(forResource: DitherSceneRenderer.resource, withExtension: "png"))
    let source = try #require(DitherSceneRenderer.loadSource(url: url))
    let image = try #require(DitherSceneRenderer.render(source, width: 120, height: 48, fade: 0.3))
    #expect(image.width == 120 && image.height == 48)
    let bitmap = NSBitmapImageRep(cgImage: image)
    func alpha(row: Int) -> Double {
        (0 ..< 120).reduce(0.0) { $0 + (bitmap.colorAt(x: $1, y: row)?.alphaComponent ?? 0) } / 120
    }
    #expect(alpha(row: 0) > 0.9, "the sky is opaque")
    #expect(alpha(row: 47) < 0.2, "the foot has dissolved into the page")
    #expect(DitherSceneRenderer.render(source, width: 0, height: 10, fade: 0.3) == nil)
}

@Test func homeSkyShipsWithTheAppAndRendersSoftenedTowardTheHorizon() throws {
    let url = try #require(DitherSceneRenderer.sourceURL(.homeSky,
                                                         main: Bundle(url: Bundle.module.bundleURL.deletingLastPathComponent())!))
    let source = try #require(DitherSceneRenderer.loadSource(url: url))
    #expect(source.width == 640 && source.height == 360)
    let plain = try #require(DitherSceneRenderer.render(source, width: 160, height: 60, fade: 0.45))
    let soft = try #require(DitherSceneRenderer.render(source, width: 160, height: 60, fade: 0.45,
                                                       tone: DitherSceneSource.homeSky.tone))
    // Mean saturation of the opaque top rows: softening must lower it.
    func saturation(_ image: CGImage) -> Double {
        let bitmap = NSBitmapImageRep(cgImage: image)
        var sum = 0.0
        for y in 0 ..< 20 { for x in 0 ..< 160 { sum += Double(bitmap.colorAt(x: x, y: y)?.saturationComponent ?? 0) } }
        return sum / 3200
    }
    #expect(saturation(soft) < saturation(plain))
    #expect(soft.width == 160 && soft.height == 60)
}
