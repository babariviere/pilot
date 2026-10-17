// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PilotMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Pilot", targets: ["Pilot"]),
        .executable(name: "PilotPower", targets: ["PilotPower"]),
        .executable(name: "PilotSystemEvents", targets: ["PilotSystemEvents"]),
    ],
    dependencies: [
        // Prebuilt libghostty (embedding C API) plus a Swift surface wrapper, vendored by
        // scripts/vendor-ghostty.sh at a pinned release. libghostty's embedder API is not a stable
        // ABI, so audit every bump.
        .package(path: "Vendor/libghostty-spm"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.8.1"),
        .package(url: "https://github.com/open-telemetry/opentelemetry-swift-core.git", exact: "2.6.0"),
        .package(url: "https://github.com/open-telemetry/opentelemetry-swift.git", exact: "2.6.0"),
        // Native Mermaid parsing, layout and CoreGraphics drawing for chat diagrams (MIT), vendored by
        // scripts/vendor-mermaidkit.sh at a pinned release with Pilot's parser patches. Its parser is
        // younger than mermaid.js, so NativeMermaid validates each parse and keeps the WebView fallback.
        .package(path: "Vendor/MermaidKit"),
    ],
    targets: [
        /// Protocol models and the transcript reducer. No UI, so it is unit-testable.
        .target(name: "PilotCore", path: "Sources/PilotCore", resources: [.copy("Resources/LinuxSSHBootstrap.py")]),
        .target(
            name: "PilotTelemetry",
            dependencies: [
                "PilotCore",
                .product(name: "OpenTelemetryApi", package: "opentelemetry-swift-core"),
                .product(name: "OpenTelemetrySdk", package: "opentelemetry-swift-core"),
                .product(name: "OpenTelemetryProtocolExporterHTTP", package: "opentelemetry-swift"),
            ],
            path: "Sources/PilotTelemetry"
        ),
        .target(name: "PilotPowerSupport", path: "Sources/PilotPowerSupport"),
        .executableTarget(name: "PilotPower", dependencies: ["PilotPowerSupport"], path: "Sources/PilotPower"),
        .testTarget(name: "PilotPowerTests", dependencies: ["PilotPowerSupport"], path: "Tests/PilotPowerTests"),
        .executableTarget(name: "PilotSystemEvents", path: "Sources/PilotSystemEvents"),
        .executableTarget(
            name: "Pilot",
            dependencies: [
                "PilotCore",
                "PilotTelemetry",
                .product(name: "GhosttyTerminal", package: "libghostty-spm"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "MermaidRender", package: "MermaidKit"),
                .product(name: "MermaidLayout", package: "MermaidKit"),
            ],
            path: "Sources/Pilot",
            resources: [.copy("Resources/Octicons-LICENSE.txt"), .copy("Resources/OpenTelemetry-LICENSE.txt"),
                        .copy("Resources/OpenTelemetry-NOTICE.txt"),
                        .copy("Resources/CoastScene.png"),
                        .copy("Resources/HomeSky.png"), .copy("Resources/HomeSkyNight.png"),
                        .copy("Resources/HomeScenes-CREDITS.txt"), .copy("Resources/MermaidKit-LICENSE.txt")],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .testTarget(name: "PilotCoreTests", dependencies: ["PilotCore"], path: "Tests/PilotCoreTests"),
        .testTarget(
            name: "PilotTelemetryTests",
            dependencies: [
                "PilotCore",
                "PilotTelemetry",
                .product(name: "OpenTelemetrySdk", package: "opentelemetry-swift-core"),
                .product(name: "OpenTelemetryProtocolExporterHTTP", package: "opentelemetry-swift"),
            ],
            path: "Tests/PilotTelemetryTests"
        ),
        .testTarget(name: "PilotUITests", dependencies: ["Pilot"], path: "Tests/PilotUITests"),
        .testTarget(name: "PilotTests", dependencies: ["Pilot"], path: "Tests/PilotTests"),
    ],
    swiftLanguageModes: [.v5]
)
