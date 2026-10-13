import Foundation
import PilotCore
import XCTest

final class MainBatcherTests: XCTestCase {
    @MainActor func testBurstIsDeliveredInOrderInOneMainTurn() async {
        var batches: [[Int]] = []
        let batcher = MainBatcher<Int> { batches.append($0) }
        let done = expectation(description: "delivered")
        DispatchQueue.global().async {
            for value in 0..<100 { batcher.append(value) }
            batcher.after { done.fulfill() }
        }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(batches.flatMap { $0 }, Array(0..<100))
        XCTAssertLessThan(batches.count, 100)
    }

    @MainActor func testAppendsWhileMainIsBusyCoalesce() async {
        var batches: [[Int]] = []
        let batcher = MainBatcher<Int> { batches.append($0) }
        // The main actor is busy for this whole synchronous run, so all three wait for one delivery.
        batcher.append(1)
        batcher.append(2)
        batcher.append(3)
        XCTAssertEqual(batches, [])
        let done = expectation(description: "delivered")
        batcher.after { done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(batches, [[1, 2, 3]])
        batcher.append(4)
        let next = expectation(description: "next")
        batcher.after { next.fulfill() }
        await fulfillment(of: [next], timeout: 5)
        XCTAssertEqual(batches, [[1, 2, 3], [4]])
    }
}
