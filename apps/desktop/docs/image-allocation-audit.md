# Pinned raster allocation audit (not a total-memory qualification)

Inputs: image0.25.10, png0.18.1, zune-jpeg0.5.15, gif0.14.2.
The configured96MiB image::Limits.max_alloc is NOT a hard total working-memory
ceiling. image/src/io/limits.rs explicitly makes allocation limits non-strict.
Transport/source/encoded buffers, decoder internals, raw output, conversion,
orientation, renderer/cache and GPU memory are distinct live allocations.

## PNG

image/src/codecs/png.rs47-61 passes the requested allocation limit into
png::Decoder::new_with_limits BEFORE read_header_info; dimension checks occur
before read_info. Constructor fixed chunk/inflater state is separate. PNG
ancillary parsing happens before pixel admission: png/decoder/stream.rs1726-28
uses bounded ICC decompression and debits retained metadata; raw chunk growth
at783-792 and text buffers at1843/1858/1878 also debit that PNG budget.
PNG decoder/mod.rs391 reserves scanline storage. The PNG error contract at
stream.rs148-155 explicitly excludes caller-provided output and says best-effort.
image PngDecoder::set_limits264-273 only records new limits; it cannot change
the png Reader's internal budget. Our use of ImageReader's PNG constructor
path matters, rather than setting limits only after construction.
The selected read_image241-258 writes one default frame into caller output;
no APNG adapter/frame collection.16-bit RGBA can require64MiB raw output under
an8MP pixel admission, then32MiB conversion. Thus the native32MiB final frame
alone does NOT prove a32MiB raw-buffer bound or96MiB total bound.

## JPEG

image/jpeg/decoder.rs29-74 first copies the admitted encoded input, then parses
headers with maximum dimensions disabled. zune decode_headers_internal402ff
parses markers/components/APP metadata, not full raster coefficient buffers;
pixel work begins later. Actual16MiB encoded input bounds marker payload bytes.
APP lengths are16-bit; Extended XMP reassembly341-384 allocates total_size ONLY
after contiguous collected payload lengths equal it, not just from its announced
32-bit size. EXIF orientation89-114 reparses headers and clones EXIF metadata.
The adapter set_limits168-176 enforces dimensions, but new_zune_decoder207-224
forwards only max width/height, NOT max_alloc. Progressive coefficient arrays
mcu_prog.rs59-105, row/coefficient/upsampler allocations484-530, components.rs
191-196 and worker.rs511 coexist with caller output. They depend on admitted
dimensions and validated component/sampling factors, not the requested96MiB.
No96MiB total ceiling is proven, including for progressive JPEG.

## GIF

image/gif.rs59-65 constructs gif::DecodeOptions before applying image limits.
gif reader/mod.rs125 defaults to50,000,000 bytes PER frame/collection, not a
total allocator budget. read_info/init327-433 parses palette/application data;
ICC and XMP are assembled from actual subblocks with try_reserve and their bytes
are bounded by the admitted encoded stream. Palettes/subblocks are fixed-size.
Image GifDecoder set_limits104ff validates the logical canvas only. The selected
read_image113-226 reads ONE frame: next_frame_info yields its independent frame
rectangle. For nonmatching rectangles image allocates an additional RGBA frame
at166-176, after limits.reserve_usize(frame width*height*4), then composites into
the caller's canvas. That second buffer is NOT bounded by canvas dimensions.
With only the initially proposed 96 MiB request, the adapter could admit 96 MiB
scratch alongside a 32 MiB canvas; the implementation now requests 32 MiB for
that independent GIF scratch buffer. GIF's
lower-level read_into_buffer is not the allocating read_next_frame path.
No total96MiB guarantee follows from these independent limits.

## Consequences

Keep WebP unsupported before its constructor. Do not claim a universal96MiB
working/RSS bound for PNG/JPEG/GIF. The implementation now admits caller raw output at32MiB and GIF independent
frame scratch at32MiB, separately from the native32MiB/cache limits. Regression
cases cover sixteen-bit raw output, a tiny GIF canvas with a64MiB frame
rectangle, and JPEG announced Extended XMP length. These guards passed the focused
19-case unit/transport run on source `f7107906` (retained immutable receipt).
They are per-allocation guarantees,
not a proven total ceiling. A mandatory hard total allocator/process bound needs
a separate architectural decision; do not invent an allocator/parser/helper or
new process boundary merely to label the current pipeline bounded.

Native image painting, fit/actual-size scroll/keyboard behavior, exact source
copy, revision replacement/decoded-pixel release and close/chat fences passed
four 680/1100 light/dark cases on source `ed50ad1b`. This is not memory profiling.
GPU atlas release is source/API evidence: `App::drop_image` calls
`Window::drop_image`, then native `MetalAtlas::remove`. Native Metal does not
override `PlatformAtlas::contains` (whose test-support default is false), so
`Window::has_image_atlas_entry` cannot establish native GPU admission/retirement.
