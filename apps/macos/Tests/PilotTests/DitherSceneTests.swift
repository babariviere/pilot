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

@Test func homeOceanSelectsASeparateNightImage() {
    #expect(DitherSceneSource.homeSky.resolved(dark: false) == .homeSky)
    #expect(DitherSceneSource.homeSky.resolved(dark: true) == .homeSkyNight)
    #expect(DitherSceneSource.coast.resolved(dark: true) == .coast)
    #expect(DitherSceneSource.coast.tone.dimsInDark)
}

@Test(arguments: [DitherSceneSource.homeSky, .homeSkyNight])
func homeOceanImagesShipAndKeepTheirOwnColours(scene: DitherSceneSource) throws {
    let buildDirectory = try #require(Bundle(url: Bundle.module.bundleURL.deletingLastPathComponent()))
    let bundled = try #require(Bundle.module.url(forResource: scene.rawValue, withExtension: "png"))
    let url = try #require(DitherSceneRenderer.sourceURL(scene, main: buildDirectory))
    #expect(url.standardizedFileURL == bundled.standardizedFileURL)
    let source = try #require(DitherSceneRenderer.loadSource(url: url))
    #expect(source.width == 1280 && source.height == 720)
    #expect(scene.tone.saturation == 1 && scene.tone.lift == 0)
    #expect(!scene.tone.dimsInDark)
    let light = try #require(DitherSceneRenderer.render(source, width: 160, height: 60, fade: 0.45,
                                                        tone: scene.tone))
    let dark = try #require(DitherSceneRenderer.render(source, width: 160, height: 60, fade: 0.45,
                                                       tone: scene.tone, dark: true))
    let lightData = try #require(light.dataProvider?.data)
    let darkData = try #require(dark.dataProvider?.data)
    #expect(lightData as Data == darkData as Data, "appearance must not darken an ocean photo")
    #expect(dark.width == 160 && dark.height == 60)
}
