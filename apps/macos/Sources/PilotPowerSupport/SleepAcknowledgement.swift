/// One native sleep token per generation. Late daemon replies and deadlines cannot acknowledge a later sleep.
public struct SleepAcknowledgement {
    public static let preparationTimeout: Double = 5
    public private(set) var generation = 0
    private var argument: Int?

    public init() {}

    public mutating func begin(argument: Int) -> Int {
        generation += 1
        self.argument = argument
        return generation
    }

    public mutating func take(generation: Int) -> Int? {
        guard generation == self.generation else { return nil }
        defer { argument = nil }
        return argument
    }

    public mutating func woke() { argument = nil }
}
