import SwiftUI

/// Wrap controls without constructing competing horizontal and vertical view trees.
/// Nested groups receive the available width, so they can wrap independently.
struct ResponsiveControlsLayout: Layout {
    var horizontalSpacing: CGFloat = 12
    var verticalSpacing: CGFloat = 6

    struct Cache {
        var idealSizes: [CGSize]
        var width: CGFloat?
        var plan: Plan?
    }

    struct Plan {
        var size: CGSize
        var origins: [CGPoint]

        init(sizes: [CGSize], width: CGFloat, horizontalSpacing: CGFloat, verticalSpacing: CGFloat) {
            var origins: [CGPoint] = []
            var x: CGFloat = 0
            var y: CGFloat = 0
            var rowHeight: CGFloat = 0
            var usedWidth: CGFloat = 0
            for size in sizes {
                if x > 0, x + size.width > width {
                    x = 0
                    y += rowHeight + verticalSpacing
                    rowHeight = 0
                }
                origins.append(CGPoint(x: x, y: y))
                usedWidth = max(usedWidth, x + size.width)
                x += size.width + horizontalSpacing
                rowHeight = max(rowHeight, size.height)
            }
            self.origins = origins
            self.size = CGSize(width: usedWidth, height: y + rowHeight)
        }
    }

    func makeCache(subviews: Subviews) -> Cache {
        Cache(idealSizes: subviews.map { $0.sizeThatFits(.unspecified) })
    }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        cache = makeCache(subviews: subviews)
    }

    private func plan(width: CGFloat?, subviews: Subviews, cache: inout Cache) -> Plan {
        let available = width.map { max(0, $0) } ?? .infinity
        if cache.width == available, let plan = cache.plan { return plan }
        let sizes = subviews.enumerated().map { index, subview in
            let ideal = cache.idealSizes[index]
            return ideal.width > available
                ? subview.sizeThatFits(ProposedViewSize(width: available, height: nil)) : ideal
        }
        let plan = Plan(sizes: sizes, width: available,
                        horizontalSpacing: horizontalSpacing, verticalSpacing: verticalSpacing)
        cache.width = available
        cache.plan = plan
        return plan
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        plan(width: proposal.width, subviews: subviews, cache: &cache).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let plan = plan(width: bounds.width, subviews: subviews, cache: &cache)
        for (index, subview) in subviews.enumerated() {
            let ideal = cache.idealSizes[index]
            subview.place(at: CGPoint(x: bounds.minX + plan.origins[index].x,
                                     y: bounds.minY + plan.origins[index].y), anchor: .topLeading,
                          proposal: ProposedViewSize(width: min(ideal.width, bounds.width), height: nil))
        }
    }
}
