//! IOKit/Network C ABI used by the legacy helper, confined to this native boundary.
use block2::Block;
use core_foundation::{
    base::{CFAllocatorRef, CFTypeRef},
    dictionary::CFDictionaryRef,
    runloop::CFRunLoopSourceRef,
    string::CFStringRef,
};
use std::ffi::{c_char, c_void};

#[repr(C)]
pub(super) struct CapabilityChange {
    pub notify_ref: u32,
    pub max_wait_for_reply: u32,
    pub change_flags: u32,
    pub reserved1: u32,
    pub from_capabilities: u32,
    pub to_capabilities: u32,
    pub reserved2: [u32; 4],
}
type Notification = extern "C" fn(*mut c_void, u32, u32, *mut c_void);
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    pub fn IORegisterForSystemPower(
        context: *mut c_void,
        port: *mut *mut c_void,
        callback: Notification,
        notifier: *mut u32,
    ) -> u32;
    pub fn IOAllowPowerChange(connection: u32, argument: isize) -> i32;
    pub fn IOServiceMatching(name: *const c_char) -> CFDictionaryRef;
    pub fn IOServiceGetMatchingService(port: u32, matching: CFDictionaryRef) -> u32;
    pub fn IOServiceAddInterestNotification(
        port: *mut c_void,
        service: u32,
        kind: *const c_char,
        callback: Notification,
        context: *mut c_void,
        notifier: *mut u32,
    ) -> i32;
    pub fn IONotificationPortSetDispatchQueue(port: *mut c_void, queue: *mut c_void);
    pub fn IORegistryEntryCreateCFProperty(
        entry: u32,
        key: CFStringRef,
        allocator: CFAllocatorRef,
        options: u32,
    ) -> CFTypeRef;
    pub fn IOPSNotificationCreateRunLoopSource(
        callback: extern "C" fn(*mut c_void),
        context: *mut c_void,
    ) -> CFRunLoopSourceRef;
    pub fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
    pub fn IOPSGetProvidingPowerSourceType(info: CFTypeRef) -> CFStringRef;
    pub fn IOPMAssertionCreateWithName(
        kind: CFStringRef,
        level: u32,
        name: CFStringRef,
        id: *mut u32,
    ) -> i32;
    pub fn IOPMAssertionRelease(id: u32) -> i32;
    pub fn IOPMCopyAssertionsByProcess(snapshot: *mut CFDictionaryRef) -> i32;
    pub fn IOPMFindPowerManagement(port: u32) -> u32;
    pub fn IOPMSleepSystem(connection: u32) -> i32;
    pub fn IOObjectRelease(object: u32) -> i32;
    pub fn IOServiceClose(connection: u32) -> i32;
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    pub fn CGGetOnlineDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    pub fn CGDisplayIsActive(display: u32) -> u32;
    pub fn CGDisplayIsAsleep(display: u32) -> u32;
}
#[link(name = "Network", kind = "framework")]
unsafe extern "C" {
    pub fn nw_path_monitor_create() -> *mut c_void;
    pub fn nw_path_monitor_create_with_type(kind: i32) -> *mut c_void;
    pub fn nw_path_monitor_set_update_handler(
        monitor: *mut c_void,
        block: &Block<dyn Fn(*mut c_void)>,
    );
    pub fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
    pub fn nw_path_monitor_start(monitor: *mut c_void);
    pub fn nw_path_get_status(path: *mut c_void) -> i32;
}
