import AppKit
import Metal
import PilotCore
import PilotVisualsKit
import QuartzCore
import SwiftUI

// Shader nodes of native visuals (docs/native-visuals.md, phase 3): the kernel translated each shader's GLSL to Metal
// at publish, and the revision carries it. Pilot compiles each translation once, off the main thread, and draws
// straight into a CAMetalLayer's drawable on the shared display clock, with the canvas's visibility and Reduce Motion
// rules.

/// One Metal device and queue for every shader node, the full-screen triangle they all draw, and a bounded cache of
/// render pipelines keyed by translation.
final class VisualMetal: @unchecked Sendable {
    static let shared = VisualMetal()
    static let pixelFormat = MTLPixelFormat.bgra8Unorm
    static let pipelineLimit = 16

    enum Failure: Error, LocalizedError {
        case unavailable
        case compile(String)

        var errorDescription: String? {
            switch self {
            case .unavailable: "Metal is not available on this Mac."
            case .compile(let message): message
            }
        }
    }

    /// Covers the drawable with one triangle; the fragment function reads only its position.
    static let vertexSource = """
    #include <metal_stdlib>
    using namespace metal;
    struct PilotVertexOut { float4 position [[position]]; };
    vertex PilotVertexOut pilot_full_screen(uint id [[vertex_id]]) {
        float2 p = float2(float((id << 1) & 2), float(id & 2));
        PilotVertexOut out;
        out.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
        return out;
    }
    """

    let device: MTLDevice?
    let queue: MTLCommandQueue?
    private let lock = NSLock()
    private var vertex: MTLFunction?
    private var pipelines: [String: Task<MTLRenderPipelineState, Error>] = [:]
    private var order: [String] = []

    init(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        self.device = device
        queue = device?.makeCommandQueue()
    }

    /// The translation's pipeline, compiled once. Concurrent callers share one compilation.
    func pipeline(_ shader: ArtifactVisualShader) async throws -> MTLRenderPipelineState {
        let key = shader.entry + "\n" + shader.msl
        let task: Task<MTLRenderPipelineState, Error> = lock.withLock {
            if let existing = pipelines[key] {
                order.removeAll { $0 == key }
                order.append(key)
                return existing
            }
            let task = Task.detached(priority: .userInitiated) { try self.compile(shader) }
            pipelines[key] = task
            order.append(key)
            while order.count > Self.pipelineLimit { pipelines[order.removeFirst()] = nil }
            return task
        }
        return try await task.value
    }

    /// Compiles on the calling thread. pipeline(_:) calls it off the main thread; screenshots call it directly.
    func compile(_ shader: ArtifactVisualShader) throws -> MTLRenderPipelineState {
        guard let device else { throw Failure.unavailable }
        do {
            let options = MTLCompileOptions()
            options.languageVersion = .version2_4
            let library = try device.makeLibrary(source: shader.msl, options: options)
            guard let fragment = library.makeFunction(name: shader.entry) else {
                throw Failure.compile("The shader's Metal has no function \(shader.entry).")
            }
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = try vertexFunction(device)
            descriptor.fragmentFunction = fragment
            descriptor.colorAttachments[0].pixelFormat = Self.pixelFormat
            return try device.makeRenderPipelineState(descriptor: descriptor)
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.compile("The shader could not be compiled for Metal: \(error.localizedDescription)")
        }
    }

    private func vertexFunction(_ device: MTLDevice) throws -> MTLFunction {
        if let vertex = lock.withLock({ vertex }) { return vertex }
        let library = try device.makeLibrary(source: Self.vertexSource, options: nil)
        guard let function = library.makeFunction(name: "pilot_full_screen") else { throw Failure.unavailable }
        lock.withLock { vertex = function }
        return function
    }

    /// Encodes one frame into texture. Returns the command buffer, uncommitted.
    func encode(_ pipeline: MTLRenderPipelineState, uniforms: [UInt8], into texture: MTLTexture) -> MTLCommandBuffer? {
        guard let buffer = queue?.makeCommandBuffer() else { return nil }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return nil }
        encoder.setRenderPipelineState(pipeline)
        uniforms.withUnsafeBytes { bytes in
            encoder.setFragmentBytes(bytes.baseAddress!, length: bytes.count, index: 0)
        }
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        return buffer
    }

    /// Renders one frame offscreen, for screenshots and tests.
    func image(_ shader: ArtifactVisualShader, uniforms: VisualShaderUniforms) throws -> CGImage {
        guard let device else { throw Failure.unavailable }
        let pipeline = try compile(shader)
        let width = max(1, Int(uniforms.width.rounded())), height = max(1, Int(uniforms.height.rounded()))
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: Self.pixelFormat, width: width,
                                                                  height: height, mipmapped: false)
        descriptor.usage = [.renderTarget]
        descriptor.storageMode = device.hasUnifiedMemory ? .shared : .managed
        guard let texture = device.makeTexture(descriptor: descriptor),
              let buffer = encode(pipeline, uniforms: uniforms.bytes, into: texture) else { throw Failure.unavailable }
        if texture.storageMode == .managed, let blit = buffer.makeBlitCommandEncoder() {
            blit.synchronize(resource: texture)
            blit.endEncoding()
        }
        buffer.commit()
        buffer.waitUntilCompleted()
        if let error = buffer.error { throw Failure.compile("The shader failed on the GPU: \(error.localizedDescription)") }
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        texture.getBytes(&pixels, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                                  bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false,
                                  intent: .defaultIntent) else { throw Failure.unavailable }
        return image
    }
}

/// The uniform buffer at index 0, laid out as the kernel's translation declares it (VISUAL_SHADER_LAYOUT): iMouse,
/// iResolution as a float4, iTime, iTimeDelta, iFrame, then one float per input, rounded up to 16 bytes. Sizes and
/// positions are in pixels with the origin at the bottom left, as in Shadertoy.
struct VisualShaderUniforms: Equatable {
    var width: Double
    var height: Double
    var time: Double = 0
    var delta: Double = 0
    var frame: Int32 = 0
    var mouse: SIMD4<Float> = .zero
    var inputs: [Float] = []

    var bytes: [UInt8] {
        let size = (44 + 4 * inputs.count + 15) / 16 * 16
        var bytes = [UInt8](repeating: 0, count: size)
        bytes.withUnsafeMutableBytes { raw in
            for (index, value) in [mouse.x, mouse.y, mouse.z, mouse.w].enumerated() {
                raw.storeBytes(of: value, toByteOffset: index * 4, as: Float.self)
            }
            for (index, value) in [Float(width), Float(height), 1, 0].enumerated() {
                raw.storeBytes(of: value, toByteOffset: 16 + index * 4, as: Float.self)
            }
            raw.storeBytes(of: Float(time), toByteOffset: 32, as: Float.self)
            raw.storeBytes(of: Float(delta), toByteOffset: 36, as: Float.self)
            raw.storeBytes(of: frame, toByteOffset: 40, as: Int32.self)
            for (index, value) in inputs.enumerated() {
                raw.storeBytes(of: value, toByteOffset: 44 + index * 4, as: Float.self)
            }
        }
        return bytes
    }
}

/// What a shader shows besides its frames: an error after a failure. Only the error line observes it.
@MainActor
final class VisualShaderOutput: ObservableObject {
    @Published fileprivate(set) var failure: VisualFailure?
}

/// Drives one shader node: compiles its translation, then draws a frame on resize, pointer moves and new input values,
/// and every display frame while animated and visible. One frame is in flight at a time; a GPU error stops the shader
/// with the error until Reload.
@MainActor
final class VisualShaderPlayer: ObservableObject {
    let output = VisualShaderOutput()
    private(set) var framesDrawn = 0

    private let metal: VisualMetal
    private let clock: VisualDisplayClock
    private weak var view: VisualShaderLayerView?
    private var shader = VisualNode.Shader(height: 240, animated: true, label: nil, glsl: "", inputs: [])
    private var translation: ArtifactVisualShader?
    private var pipeline: MTLRenderPipelineState?
    private var compiling: String?
    private var reduceMotion = false
    private var visible = false
    private var stopped = false
    private var inFlight = false
    private var dirty = false
    private var pointer: CGPoint?
    private var elapsed: Double = 0
    private var delta: Double = 0
    private var lastTick: CFTimeInterval?

    init(metal: VisualMetal? = nil, clock: VisualDisplayClock? = nil) {
        self.metal = metal ?? .shared
        self.clock = clock ?? .shared
    }

    deinit {
        let clock = clock
        let id = ObjectIdentifier(self)
        Task { @MainActor in clock.unsubscribe(id: id) }
    }

    var animating: Bool { shader.animated && visible && !reduceMotion && !stopped && pipeline != nil }

    func attach(_ view: VisualShaderLayerView) {
        self.view = view
        view.metalLayer.device = metal.device
        view.resized = { [weak self] in self?.request() }
        request()
    }

    func configure(shader: VisualNode.Shader, translation: ArtifactVisualShader?, reduceMotion: Bool) {
        let motionChanged = self.reduceMotion != reduceMotion
        self.shader = shader
        self.reduceMotion = reduceMotion
        if motionChanged, reduceMotion { elapsed = 0 }
        if translation != self.translation {
            self.translation = translation
            pipeline = nil
            compile()
        }
        updateClock()
        request()
    }

    func setVisible(_ visible: Bool) {
        guard visible != self.visible else { return }
        self.visible = visible
        updateClock()
        if visible { request() }
    }

    func point(_ location: CGPoint?) {
        guard location != pointer else { return }
        pointer = location
        if !animating { request() }
    }

    func retry() {
        stopped = false
        output.failure = nil
        if pipeline == nil { compile() }
        updateClock()
        request()
    }

    private func compile() {
        guard let translation else {
            stop(.unavailable("This shader has no Metal translation. Publish the visual again with a newer Pilot."))
            return
        }
        let key = translation.msl
        compiling = key
        let metal = metal
        Task { [weak self] in
            let result: Result<MTLRenderPipelineState, Error>
            do { result = .success(try await metal.pipeline(translation)) } catch { result = .failure(error) }
            guard let self, self.compiling == key else { return }
            self.compiling = nil
            switch result {
            case .success(let pipeline):
                self.pipeline = pipeline
                self.updateClock()
                self.request()
            case .failure(let error):
                self.stop(.unavailable(error.localizedDescription))
            }
        }
    }

    private func updateClock() {
        if animating {
            clock.subscribe(self) { [weak self] time in self?.tick(time) }
        } else {
            clock.unsubscribe(self)
            lastTick = nil
        }
    }

    private func tick(_ time: CFTimeInterval) {
        if let lastTick {
            delta = min(max(0, time - lastTick), 0.1)
            elapsed += delta
        }
        lastTick = time
        request()
    }

    private func request() {
        dirty = true
        draw()
    }

    private func draw() {
        // Like canvases, a shader out of sight draws only its first frame.
        guard dirty, !inFlight, !stopped, let pipeline, let view, visible || framesDrawn == 0 else { return }
        let layer = view.metalLayer
        let size = layer.drawableSize
        guard size.width >= 1, size.height >= 1 else { return }
        let scale = layer.contentsScale
        var uniforms = VisualShaderUniforms(width: size.width, height: size.height)
        uniforms.time = shader.animated && !reduceMotion ? elapsed : 0
        uniforms.delta = shader.animated && !reduceMotion ? delta : 0
        uniforms.frame = Int32(clamping: framesDrawn)
        uniforms.inputs = shader.inputs.map { Float($0.value) }
        if let pointer {
            let x = Float(pointer.x * scale), y = Float(size.height - pointer.y * scale)
            uniforms.mouse = SIMD4(x, y, 0, 0)
        }
        guard let drawable = layer.nextDrawable(),
              let buffer = metal.encode(pipeline, uniforms: uniforms.bytes, into: drawable.texture) else { return }
        dirty = false
        inFlight = true
        framesDrawn += 1
        buffer.present(drawable)
        buffer.addCompletedHandler { [weak self] buffer in
            let error = buffer.error.map { "The shader failed on the GPU: \($0.localizedDescription)" }
            Task { @MainActor in self?.finish(error) }
        }
        buffer.commit()
    }

    private func finish(_ error: String?) {
        inFlight = false
        if let error { return stop(.unavailable(error)) }
        draw()
    }

    private func stop(_ failure: VisualFailure) {
        stopped = true
        output.failure = failure
        updateClock()
    }
}

/// A view backed by a CAMetalLayer whose drawable follows its size in pixels.
final class VisualShaderLayerView: NSView {
    let metalLayer = CAMetalLayer()
    var resized: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        metalLayer.pixelFormat = VisualMetal.pixelFormat
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = false
        metalLayer.maximumDrawableCount = 3
        metalLayer.allowsNextDrawableTimeout = true
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func makeBackingLayer() -> CALayer { metalLayer }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateDrawableSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        metalLayer.contentsScale = scale
        let size = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
        guard size != metalLayer.drawableSize else { return }
        metalLayer.drawableSize = size
        resized?()
    }
}

private struct VisualShaderSurface: NSViewRepresentable {
    let player: VisualShaderPlayer

    func makeNSView(context: Context) -> VisualShaderLayerView {
        let view = VisualShaderLayerView(frame: .zero)
        player.attach(view)
        return view
    }

    func updateNSView(_ view: VisualShaderLayerView, context: Context) {}
}

/// A shader node: as wide as the column and as tall as the tree says.
struct VisualShaderView: View {
    let shader: VisualNode.Shader
    let model: VisualArtifactModel
    @StateObject private var player = VisualShaderPlayer()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VisualShaderSurface(player: player)
                .frame(maxWidth: .infinity)
                .frame(height: shader.height)
                .contentShape(Rectangle())
                .onContinuousHover(coordinateSpace: .local) { phase in
                    switch phase {
                    case .active(let location): player.point(location)
                    case .ended: player.point(nil)
                    }
                }
                .background(VisualCanvasVisibility { player.setVisible($0) })
                .accessibilityElement()
                .accessibilityLabel(shader.label ?? "Animated shader")
                .accessibilityAddTraits(.isImage)
            VisualShaderFailure(output: player.output, retry: player.retry)
        }
        .onAppear { configure() }
        .onChange(of: shader) { configure() }
        .onChange(of: reduceMotion) { configure() }
    }

    private func configure() {
        player.configure(shader: shader, translation: model.translation(for: shader), reduceMotion: reduceMotion)
    }
}

private struct VisualShaderFailure: View {
    @ObservedObject var output: VisualShaderOutput
    let retry: () -> Void

    var body: some View {
        if let failure = output.failure {
            VisualFailureLine(failure: failure, retry: retry)
        }
    }
}

/// A shader's first frame, rendered offscreen: for screenshots, which render once.
struct VisualShaderStill: View {
    let shader: VisualNode.Shader
    let model: VisualArtifactModel

    var body: some View {
        GeometryReader { proxy in
            if let image = image(width: proxy.size.width) {
                Image(decorative: image, scale: 2).resizable()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: shader.height)
    }

    private func image(width: CGFloat) -> CGImage? {
        guard width > 0, let translation = model.translation(for: shader) else { return nil }
        var uniforms = VisualShaderUniforms(width: width * 2, height: shader.height * 2)
        uniforms.inputs = shader.inputs.map { Float($0.value) }
        return try? VisualMetal.shared.image(translation, uniforms: uniforms)
    }
}
