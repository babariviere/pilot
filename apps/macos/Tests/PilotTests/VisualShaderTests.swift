import AppKit
import Foundation
import Metal
import PilotVisualsKit
import Testing
@testable import Pilot
@testable import PilotCore

/// packages/protocol/fixtures/visual/shaders.json: the kernel's Metal for a probe shader, with the colors the app must
/// draw for given uniforms. It checks the uniform layout, the y flip and premultiplied alpha across the boundary.
struct VisualShaderTests {
    static let repository = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../..")
        .standardizedFileURL

    static func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: repository.appending(path: "packages/protocol/fixtures/visual/shaders.json"))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func uniformsFollowTheKernelsLayout() throws {
        let layout = try #require(Self.fixture()["layout"] as? [String: Int])
        #expect(layout == ["iMouse": 0, "iResolution": 16, "iTime": 32, "iTimeDelta": 36, "iFrame": 40, "inputs": 44])
        var uniforms = VisualShaderUniforms(width: 640, height: 480, time: 1.5, delta: 0.25, frame: 7,
                                            mouse: SIMD4(1, 2, 3, 4), inputs: [9, 10])
        let bytes = uniforms.bytes
        #expect(bytes.count == 64)
        func float(_ offset: Int) -> Float { bytes.withUnsafeBytes { $0.load(fromByteOffset: offset, as: Float.self) } }
        #expect((0..<4).map { float($0 * 4) } == [1, 2, 3, 4])
        #expect((4..<8).map { float($0 * 4) } == [640, 480, 1, 0])
        #expect(float(32) == 1.5 && float(36) == 0.25)
        #expect(bytes.withUnsafeBytes { $0.load(fromByteOffset: 40, as: Int32.self) } == 7)
        #expect(float(44) == 9 && float(48) == 10)
        uniforms.inputs = []
        #expect(uniforms.bytes.count == 48)
    }

    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func drawsTheKernelsTranslation() throws {
        for item in try #require(Self.fixture()["shaders"] as? [[String: Any]]) {
            let shader = ArtifactVisualShader(
                glsl: try #require(item["glsl"] as? String), inputs: try #require(item["inputs"] as? [String]),
                msl: try #require(item["msl"] as? String), entry: try #require(item["entry"] as? String))
            let values = try #require(item["uniforms"] as? [String: Any])
            let mouse = try #require(values["mouse"] as? [Double]).map(Float.init)
            let uniforms = VisualShaderUniforms(
                width: try #require(values["width"] as? Double), height: try #require(values["height"] as? Double),
                time: values["time"] as? Double ?? 0, frame: Int32(values["frame"] as? Int ?? 0),
                mouse: SIMD4(mouse[0], mouse[1], mouse[2], mouse[3]),
                inputs: try #require(values["inputs"] as? [Double]).map(Float.init))
            let image = try VisualMetal().image(shader, uniforms: uniforms)
            let pixels = try Self.premultipliedPixels(image)
            for probe in try #require(item["pixels"] as? [[String: Any]]) {
                let x = try #require(probe["x"] as? Int), y = try #require(probe["y"] as? Int)
                let expected = try #require(probe["rgba"] as? [Double])
                let actual = pixels[y * image.width + x]
                for channel in 0..<4 {
                    #expect(abs(actual[channel] - expected[channel]) < 2.5 / 255, "pixel \(x),\(y) channel \(channel)")
                }
            }
        }
    }

    @Test(.enabled(if: MTLCreateSystemDefaultDevice() != nil)) func badMetalFailsWithAMessage() {
        let shader = ArtifactVisualShader(glsl: "", inputs: [], msl: "this is not metal", entry: "main_")
        #expect(throws: VisualMetal.Failure.self) { try VisualMetal().compile(shader) }
    }

    /// RGBA in 0...1 per pixel, read from the BGRA premultiplied image the renderer returns.
    static func premultipliedPixels(_ image: CGImage) throws -> [[Double]] {
        let data = try #require(image.dataProvider?.data as Data?)
        return stride(from: 0, to: image.width * image.height * 4, by: 4).map { offset in
            [data[offset + 2], data[offset + 1], data[offset], data[offset + 3]].map { Double($0) / 255 }
        }
    }
}
