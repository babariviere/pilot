# Window surfaces

Pilot Next uses opaque window, page and sidebar surfaces in both appearances.
It does not request native backdrop blur or vibrancy. Ordinary overlays and
selection washes remain translucent. The hidden `glass` and `native_glass`
regressions retain their historical target names; they check opaque surfaces and
native window behavior, not visible compositor effects.
