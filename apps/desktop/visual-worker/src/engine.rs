use std::ffi::{CStr, c_char, c_int, c_void};
#[repr(C)]
struct Limits {
    heap: usize,
    stack: usize,
    setup: u32,
    view: u32,
    handler: u32,
    draw: u32,
}
#[repr(C)]
struct Buffer {
    bytes: *mut u8,
    length: usize,
}
unsafe extern "C" {
    fn pv_engine_create(limits: Limits) -> *mut c_void;
    fn pv_engine_version() -> *const c_char;
    fn pv_engine_load(
        engine: *mut c_void,
        runtime: *const u8,
        runtime_len: usize,
        source: *const u8,
        source_len: usize,
        data: *const u8,
        data_len: usize,
        state: *const u8,
        state_len: usize,
        seed: *const u8,
        seed_len: usize,
        now: f64,
        result: *mut Buffer,
    ) -> c_int;
    fn pv_engine_event(
        engine: *mut c_void,
        id: *const u8,
        id_len: usize,
        value: *const u8,
        value_len: usize,
        now: f64,
        result: *mut Buffer,
    ) -> c_int;
    fn pv_engine_draw(
        engine: *mut c_void,
        id: *const u8,
        id_len: usize,
        width: f64,
        height: f64,
        t: f64,
        has_pointer: c_int,
        x: f64,
        y: f64,
        out: *mut u8,
        capacity: usize,
        written: *mut usize,
        result: *mut Buffer,
    ) -> c_int;
    fn pv_buffer_free(buffer: *mut Buffer);
}
pub const RUNTIME: &str = include_str!("../../../../packages/artifacts/src/visual/runtime.js");
pub struct Engine(*mut c_void);
impl Engine {
    pub fn new() -> Option<Self> {
        let e = unsafe {
            pv_engine_create(Limits {
                heap: 32 * 1024 * 1024,
                stack: 512 * 1024,
                setup: 250,
                view: 250,
                handler: 100,
                draw: 8,
            })
        };
        (!e.is_null()).then_some(Self(e))
    }
    pub fn version() -> &'static str {
        unsafe { CStr::from_ptr(pv_engine_version()) }
            .to_str()
            .unwrap_or("unknown")
    }
    fn result(
        &mut self,
        call: impl FnOnce(*mut c_void, *mut Buffer) -> c_int,
    ) -> Result<(bool, Vec<u8>), ()> {
        let mut out = Buffer {
            bytes: std::ptr::null_mut(),
            length: 0,
        };
        let status = call(self.0, &mut out);
        if out.bytes.is_null() || out.length > 2 * 1024 * 1024 {
            unsafe { pv_buffer_free(&mut out) };
            return Err(());
        }
        let bytes = unsafe { std::slice::from_raw_parts(out.bytes, out.length) }.to_vec();
        unsafe { pv_buffer_free(&mut out) };
        Ok((status == 0, bytes))
    }
    pub fn load(
        &mut self,
        source: &str,
        data: &str,
        state: Option<&str>,
        seed: &str,
        now: f64,
    ) -> Result<(bool, Vec<u8>), ()> {
        let s = state.unwrap_or("");
        self.result(|e, out| unsafe {
            pv_engine_load(
                e,
                RUNTIME.as_ptr(),
                RUNTIME.len(),
                source.as_ptr(),
                source.len(),
                data.as_ptr(),
                data.len(),
                if state.is_some() {
                    s.as_ptr()
                } else {
                    std::ptr::null()
                },
                s.len(),
                seed.as_ptr(),
                seed.len(),
                now,
                out,
            )
        })
    }
    pub fn event(&mut self, id: &str, value: &str, now: f64) -> Result<(bool, Vec<u8>), ()> {
        self.result(|e, out| unsafe {
            pv_engine_event(
                e,
                id.as_ptr(),
                id.len(),
                value.as_ptr(),
                value.len(),
                now,
                out,
            )
        })
    }
    pub fn draw(
        &mut self,
        id: &str,
        width: f64,
        height: f64,
        t: f64,
        pointer: Option<(f64, f64)>,
    ) -> Result<(bool, Vec<u8>), ()> {
        self.result(|e, out| {
            let mut written = 0;
            unsafe {
                pv_engine_draw(
                    e,
                    id.as_ptr(),
                    id.len(),
                    width,
                    height,
                    t,
                    i32::from(pointer.is_some()),
                    pointer.map_or(0., |p| p.0),
                    pointer.map_or(0., |p| p.1),
                    std::ptr::null_mut(),
                    0,
                    &mut written,
                    out,
                )
            }
        })
    }
}
// No Drop: process teardown reclaims the VM. Never run a potentially damaged VM's finalizers after failure.
