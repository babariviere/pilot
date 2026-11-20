// swift-tools-version: 6.2
import PackageDescription

// Shared helper inputs only. The obsolete Swift GUI and its dependencies are removed.
let package = Package(
    name: "PilotNativeHelpers",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "PilotSystemEvents", targets: ["PilotSystemEvents"]),
    ],
    targets: [
        .target(name: "PilotPowerSupport", path: "Sources/PilotPowerSupport"),
        .executableTarget(name: "PilotSystemEvents", path: "Sources/PilotSystemEvents"),
        .testTarget(name: "PilotPowerTests", dependencies: ["PilotPowerSupport"], path: "Tests/PilotPowerTests"),
    ],
    swiftLanguageModes: [.v5]
)

for target in package.targets {
    target.swiftSettings = [.unsafeFlags(["-warnings-as-errors"])]
}
