//! Thin native boundary. Tests never construct this backend or call these power APIs.
mod commands;
mod ffi;
use crate::{
    guardian,
    protocol::{self, ReplyReader},
    runtime::{Event, Operations, Runtime, Sample},
    support::{self, SleepAcknowledgement},
};
use block2::RcBlock;
use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    number::CFNumber,
    runloop::{CFRunLoop, kCFRunLoopCommonModes},
    string::CFString,
};
use dispatch2::{DispatchQueue, DispatchTime};
use ffi::*;
use serde_json::json;
use std::{
    ffi::c_void,
    io,
    process::{ChildStdin, Command, Stdio},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
};

struct Sensors {
    send: mpsc::Sender<Event>,
    connection: AtomicU32,
    root: AtomicU32,
    available: AtomicBool,
    sleeping: AtomicBool,
    wifi: AtomicBool,
    online: AtomicBool,
    ack: Mutex<SleepAcknowledgement>,
    latest: Mutex<Sample>,
    stopping: AtomicBool,
}
impl Sensors {
    fn allow_sleep(&self, generation: u64) {
        let mut ack = self
            .ack
            .lock()
            .expect("sleep acknowledgement lock poisoned");
        if let Some(argument) = ack.take(generation) {
            // SAFETY: connection is the live IORegisterForSystemPower handle; token is consumed once.
            unsafe {
                IOAllowPowerChange(self.connection.load(Ordering::Relaxed), argument);
            }
        }
    }
    fn report(&self, capabilities: Option<u32>) {
        let root = self.root.load(Ordering::Relaxed);
        let caps = capabilities
            .or_else(|| {
                property(root, "System Capabilities")?
                    .downcast::<CFNumber>()?
                    .to_i64()
                    .map(|v| v as u32)
            })
            .unwrap_or(0);
        let closed = property(root, "AppleClamshellState")
            .as_ref()
            .and_then(cf_bool);
        let sleeping = self.sleeping.load(Ordering::Relaxed);
        let sample = Sample {
            available: self.available.load(Ordering::Relaxed),
            connected_to_power: connected_to_power(),
            wifi_connected: self.wifi.load(Ordering::Relaxed),
            online: self.online.load(Ordering::Relaxed),
            lid_closed: closed,
            sleeping,
            full_wake: !sleeping && display_awake() && caps & 2 != 0,
            wake_token: wake_token(),
            sleep_generation: self
                .ack
                .lock()
                .expect("sleep acknowledgement lock poisoned")
                .generation,
            ..Default::default()
        };
        *self.latest.lock().expect("sensor lock poisoned") = sample.clone();
        let _ = self.send.send(Event::Sample(sample));
    }
}

extern "C" fn power(context: *mut c_void, _service: u32, message: u32, argument: *mut c_void) {
    // SAFETY: start_sensors retains this Arc allocation until process exit; callbacks are serialized on main.
    let sensors = unsafe { &*context.cast::<Sensors>() };
    match message {
        0xe0000270 => {
            // SAFETY: OS-supplied idle-sleep notification token and its registered connection.
            unsafe {
                IOAllowPowerChange(
                    sensors.connection.load(Ordering::Relaxed),
                    argument as isize,
                );
            }
        }
        0xe0000280 => {
            sensors.sleeping.store(true, Ordering::Relaxed);
            let generation = sensors
                .ack
                .lock()
                .expect("sleep acknowledgement lock poisoned")
                .begin(argument as isize);
            sensors.report(None);
            // SAFETY: the permanent context keeps this allocation alive. This clone owns the timer context.
            let sensors = unsafe {
                Arc::increment_strong_count(context.cast::<Sensors>());
                Arc::from_raw(context.cast::<Sensors>())
            };
            let _ = DispatchQueue::main().after(
                DispatchTime::try_from(support::PREPARATION_TIMEOUT)
                    .expect("five seconds fits dispatch time"),
                move || sensors.allow_sleep(generation),
            );
        }
        0xe0000300 => {
            sensors.sleeping.store(false, Ordering::Relaxed);
            sensors
                .ack
                .lock()
                .expect("sleep acknowledgement lock poisoned")
                .woke();
            sensors.report(None);
        }
        _ => {}
    }
}
extern "C" fn lid(context: *mut c_void, _service: u32, _message: u32, _argument: *mut c_void) {
    // SAFETY: permanently retained notification context, as for power().
    unsafe { &*context.cast::<Sensors>() }.report(None);
}
extern "C" fn capability(context: *mut c_void, _service: u32, message: u32, argument: *mut c_void) {
    if message != 0xe0000340 || argument.is_null() {
        return;
    }
    // SAFETY: IOKit supplies this documented parameter layout for capability-change messages.
    let change = unsafe { &*argument.cast::<CapabilityChange>() };
    if change.change_flags & 2 != 0 {
        // SAFETY: permanently retained notification context.
        let sensors = unsafe { &*context.cast::<Sensors>() };
        sensors
            .sleeping
            .store(change.to_capabilities & 1 == 0, Ordering::Relaxed);
        sensors.report(Some(change.to_capabilities));
    }
}
extern "C" fn ac(context: *mut c_void) {
    // SAFETY: permanently retained notification context.
    unsafe { &*context.cast::<Sensors>() }.report(None);
}

fn start_sensors(sensors: Arc<Sensors>) {
    let context = Arc::into_raw(sensors.clone()).cast_mut().cast::<c_void>();
    let mut port = ptr::null_mut();
    let (mut notifier, mut lid_notifier, mut capability_notifier) = (0, 0, 0);
    // SAFETY: valid out parameters and retained callback context; native handles live until process exit.
    unsafe {
        let connection = IORegisterForSystemPower(context, &mut port, power, &mut notifier);
        sensors.connection.store(connection, Ordering::Relaxed);
        let root = IOServiceGetMatchingService(0, IOServiceMatching(c"IOPMrootDomain".as_ptr()));
        sensors.root.store(root, Ordering::Relaxed);
        if !port.is_null() {
            if root != 0 {
                IOServiceAddInterestNotification(
                    port,
                    root,
                    c"IOGeneralInterest".as_ptr(),
                    lid,
                    context,
                    &mut lid_notifier,
                );
                IOServiceAddInterestNotification(
                    port,
                    root,
                    c"IOPriorityPowerStateInterest".as_ptr(),
                    capability,
                    context,
                    &mut capability_notifier,
                );
            }
            IONotificationPortSetDispatchQueue(
                port,
                DispatchQueue::main() as *const DispatchQueue as *mut c_void,
            );
        }
        let source = IOPSNotificationCreateRunLoopSource(ac, context);
        if !source.is_null() {
            core_foundation::runloop::CFRunLoopAddSource(
                CFRunLoop::get_main().as_concrete_TypeRef(),
                source,
                kCFRunLoopCommonModes,
            );
        }
        sensors.available.store(
            connection != 0 && lid_notifier != 0 && capability_notifier != 0,
            Ordering::Relaxed,
        );
        for wifi in [true, false] {
            let monitor = if wifi {
                nw_path_monitor_create_with_type(1)
            } else {
                nw_path_monitor_create()
            };
            if monitor.is_null() {
                continue;
            }
            let sensors = sensors.clone();
            let block = RcBlock::new(move |path: *mut c_void| {
                let status = nw_path_get_status(path);
                if wifi {
                    sensors.wifi.store(status == 1, Ordering::Relaxed);
                } else {
                    sensors.online.store(status != 2, Ordering::Relaxed);
                }
                sensors.report(None);
            });
            nw_path_monitor_set_update_handler(monitor, &block);
            nw_path_monitor_set_queue(
                monitor,
                DispatchQueue::main() as *const DispatchQueue as *mut c_void,
            );
            nw_path_monitor_start(monitor);
            // Network.framework copies the block. The process owns both monitors until exit.
        }
    }
    sensors.report(None);
}

pub(super) fn property(root: u32, key: &str) -> Option<CFType> {
    if root == 0 {
        return None;
    }
    let key = CFString::new(key);
    // SAFETY: valid service and CFString; Create returns an owned CF object or null.
    let value =
        unsafe { IORegistryEntryCreateCFProperty(root, key.as_concrete_TypeRef(), ptr::null(), 0) };
    if value.is_null() {
        None
    } else {
        Some(unsafe { CFType::wrap_under_create_rule(value) })
    }
}
pub(super) fn cf_bool(value: &CFType) -> Option<bool> {
    value.downcast::<CFBoolean>().map(bool::from).or_else(|| {
        match value.downcast::<CFNumber>()?.to_i64()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    })
}
fn connected_to_power() -> bool {
    // SAFETY: Copy returns an owned CF object; providing source string is borrowed from that snapshot.
    unsafe {
        let info = IOPSCopyPowerSourcesInfo();
        if info.is_null() {
            return false;
        }
        let info = CFType::wrap_under_create_rule(info);
        let source = IOPSGetProvidingPowerSourceType(info.as_CFTypeRef());
        !source.is_null() && CFString::wrap_under_get_rule(source) == "AC Power"
    }
}
fn display_awake() -> bool {
    let mut displays = [0; 32];
    let mut count = 0;
    // SAFETY: correctly sized output array; returned display IDs are used only by CoreGraphics queries.
    unsafe {
        CGGetOnlineDisplayList(32, displays.as_mut_ptr(), &mut count) == 0
            && displays[..(count as usize).min(32)]
                .iter()
                .any(|id| CGDisplayIsActive(*id) != 0 && CGDisplayIsAsleep(*id) == 0)
    }
}
fn wake_token() -> String {
    // SAFETY: timeval and size match kern.waketime's ABI; no new value is supplied.
    unsafe {
        let mut time: libc::timeval = std::mem::zeroed();
        let mut size = std::mem::size_of_val(&time);
        if libc::sysctlbyname(
            c"kern.waketime".as_ptr(),
            (&mut time as *mut libc::timeval).cast(),
            &mut size,
            ptr::null_mut(),
            0,
        ) != 0
        {
            return "0:0".into();
        }
        format!("{}:{}", time.tv_sec, time.tv_usec)
    }
}

type GuardianInput = Arc<Mutex<Option<ChildStdin>>>;
fn guardian_send(input: &GuardianInput, value: serde_json::Value) {
    if let Some(input) = input.lock().expect("guardian input lock poisoned").as_mut() {
        let _ = protocol::emit(input, &value);
    }
}
enum Work {
    Activity { id: i64, awake: bool, closed: bool },
    Authorize(i64),
    Shutdown,
}
struct Native {
    sensors: Arc<Sensors>,
    guardian: GuardianInput,
    work: mpsc::Sender<Work>,
    assertion: u32,
}
impl Operations for Native {
    fn set_awake(&mut self, on: bool) -> bool {
        // SAFETY: assertion ID is owned by this coordinator; only a system-idle assertion is ever created.
        unsafe {
            if !on && self.assertion != 0 {
                IOPMAssertionRelease(self.assertion);
                self.assertion = 0;
            }
            if on && self.assertion == 0 {
                return IOPMAssertionCreateWithName(
                    CFString::new("PreventUserIdleSystemSleep").as_concrete_TypeRef(),
                    255,
                    CFString::new("Pilot agents are working").as_concrete_TypeRef(),
                    &mut self.assertion,
                ) == 0;
            }
        }
        true
    }
    fn allow_sleep(&mut self, generation: u64) {
        self.sensors.allow_sleep(generation);
    }
    fn heartbeat(&mut self) {
        guardian_send(&self.guardian, json!({"heartbeat":true}));
    }
    fn activity(&mut self, id: i64, awake: bool, closed: bool) {
        let _ = self.work.send(Work::Activity { id, awake, closed });
    }
    fn authorize(&mut self, id: i64) {
        let _ = self.work.send(Work::Authorize(id));
    }
    fn sleep_closed_lid(&mut self) -> bool {
        commands::sleep_closed_lid()
    }
    fn shutdown(&mut self) {
        self.sensors.stopping.store(true, Ordering::Relaxed);
        let generation = self
            .sensors
            .ack
            .lock()
            .expect("sleep acknowledgement lock poisoned")
            .generation;
        self.sensors.allow_sleep(generation);
        self.guardian
            .lock()
            .expect("guardian input lock poisoned")
            .take();
        let _ = self.work.send(Work::Shutdown);
    }
}
fn worker(sensors: Arc<Sensors>, input: GuardianInput, rx: mpsc::Receiver<Work>) {
    let mut process = match std::env::current_exe().and_then(|exe| {
        Command::new(exe)
            .arg("--guardian")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    }) {
        Ok(child) => child,
        Err(_) => {
            let _ = sensors.send.send(Event::Stop);
            return;
        }
    };
    let mut replies = ReplyReader::new(process.stdout.take().expect("guardian stdout piped"));
    *input.lock().expect("guardian input lock poisoned") = process.stdin.take();
    let send = sensors.send.clone();
    std::thread::spawn(move || {
        let _ = process.wait();
        let _ = send.send(Event::Stop);
    });
    if !replies.read_reply() {
        let _ = sensors.send.send(Event::Stop);
    } else {
        let _ = sensors.send.send(Event::Ready {
            authorized: commands::permission_ready(),
        });
    }
    while let Ok(work) = rx.recv() {
        match work {
            Work::Shutdown => {
                input.lock().expect("guardian input lock poisoned").take();
                if let Some((_lock, mut state)) = commands::override_lock() {
                    guardian::restore(&mut state);
                }
                std::process::exit(0);
            }
            _ if sensors.stopping.load(Ordering::Relaxed) => continue,
            Work::Authorize(id) => {
                let ok = commands::authorize();
                let _ = sensors.send.send(Event::Authorized { id, ok });
            }
            Work::Activity { id, awake, closed } => {
                // Revalidate immediately before the global write, not when the daemon queued the request.
                let closed = {
                    let sample = sensors.latest.lock().expect("sensor lock poisoned");
                    closed
                        && sample.connected_to_power
                        && sample.wifi_connected
                        && !sample.sleeping
                        && !sensors.stopping.load(Ordering::Relaxed)
                };
                guardian_send(&input, json!({"on":closed}));
                let ok = replies.read_reply();
                let permission = if ok {
                    None
                } else {
                    Some(commands::permission_ready())
                };
                let _ = sensors.send.send(Event::Activity {
                    id,
                    awake,
                    closed,
                    ok,
                    permission,
                });
            }
        }
    }
}

pub(crate) fn run() {
    // SAFETY: ignoring SIGPIPE makes a dead peer an ordinary pipe error.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    if std::env::args().skip(1).eq(["--guardian"]) {
        if let Some((_lock, mut state)) = commands::override_lock() {
            guardian::run(&mut state, io::stdin(), &mut io::stdout());
        } else {
            let _ = protocol::emit(&mut io::stdout(), &json!({"ok":false}));
        }
        std::process::exit(0);
    }
    let (tx, rx) = mpsc::channel();
    let sensors = Arc::new(Sensors {
        send: tx.clone(),
        connection: AtomicU32::new(0),
        root: AtomicU32::new(0),
        available: AtomicBool::new(false),
        sleeping: AtomicBool::new(false),
        wifi: AtomicBool::new(false),
        online: AtomicBool::new(false),
        ack: Mutex::new(SleepAcknowledgement::default()),
        latest: Mutex::new(Sample::default()),
        stopping: AtomicBool::new(false),
    });
    start_sensors(sensors.clone());
    let send = tx.clone();
    guardian::read_frames(io::stdin(), 8192, move |value| {
        let _ = send.send(value.map_or(Event::Stop, Event::Frame));
    });
    let mut signals = signal_hook::iterator::Signals::new([libc::SIGTERM, libc::SIGINT])
        .expect("install power shutdown signals");
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            let _ = tx.send(Event::Stop);
        }
    });
    let (work_tx, work_rx) = mpsc::channel();
    let input = Arc::new(Mutex::new(None));
    let native = Native {
        sensors: sensors.clone(),
        guardian: input.clone(),
        work: work_tx,
        assertion: 0,
    };
    std::thread::spawn(move || worker(sensors, input, work_rx));
    std::thread::spawn(move || {
        crate::runtime::run(Runtime::new(native, io::stdout()), rx);
    });
    CFRunLoop::run_current();
}
