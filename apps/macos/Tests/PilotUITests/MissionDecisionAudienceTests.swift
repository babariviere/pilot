import AppKit
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

@Test func decisionAudienceChoicesUsePlainLabelsAndExplainContext() {
    #expect(MissionDecisionAudience.allCases.map(\.label) == ["All chats", "Coordinator only", "Reference"])
    #expect(MissionDecisionAudience.all.explanation.contains("every mission chat"))
    #expect(MissionDecisionAudience.coordinator.explanation.contains("unless pinned"))
    #expect(MissionDecisionAudience.reference.explanation.contains("on request"))
}

@Test @MainActor func audienceTagsAndPickersFitNarrowDecisionRows() {
    _ = NSApplication.shared
    for audience in MissionDecisionAudience.allCases {
        for width: CGFloat in [240, 680] {
            let tag = NSHostingView(rootView: DecisionAudienceTag(audience: audience))
            #expect(tag.fittingSize.width < width)
            #expect(tag.fittingSize.height > 0)
            let picker = NSHostingView(rootView: DecisionAudiencePicker(selection: .constant(audience)))
            #expect(picker.fittingSize.width < width)
            #expect(picker.fittingSize.height > 0)
            let row = NSHostingView(rootView: VStack(alignment: .leading, spacing: 4) {
                Text(String(repeating: "A long decision remains readable. ", count: 6))
                    .font(.pilot(.body)).fixedSize(horizontal: false, vertical: true)
                DecisionAudienceTag(audience: audience)
            }.frame(width: width).fixedSize(horizontal: false, vertical: true))
            #expect(abs(row.fittingSize.width - width) < 0.01)
            #expect(row.fittingSize.height > tag.fittingSize.height)
        }
    }
}
