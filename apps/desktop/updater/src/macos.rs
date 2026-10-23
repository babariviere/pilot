//! Main-thread-only native Sparkle probe. No framework loading or credential discovery.
use crate::{Backend, Candidate, Completion, Error, Outcome, Safety, Trigger};
use std::{
    ffi::{CString, c_char, c_void},
    marker::PhantomData,
    ptr::NonNull,
    rc::Rc,
};

#[repr(C)]
struct Event {
    operation: u64,
    kind: i32,
    error: i32,
    version: [c_char; 81],
}

unsafe extern "C" {
    fn pnu_is_main_thread() -> bool;
    fn pnu_create(
        expected_bundle_id: *const c_char,
        wake: extern "C" fn(*mut c_void),
        context: *mut c_void,
    ) -> *mut c_void;
    fn pnu_check(handle: *mut c_void, operation: u64, token: *const c_char) -> i32;
    fn pnu_cancel(handle: *mut c_void, operation: u64);
    fn pnu_take_event(handle: *mut c_void, event: *mut Event) -> bool;
    fn pnu_destroy(handle: *mut c_void);
}

fn error(code: i32) -> Error {
    match code {
        1 => Error::Unconfigured,
        2 => Error::Authentication,
        3 => Error::Offline,
        4 => Error::InvalidResponse,
        5 => Error::RedirectDenied,
        6 => Error::Identity,
        7 => Error::Version,
        8 => Error::Signature,
        9 => Error::Busy,
        _ => Error::Native,
    }
}

/// Existing approved provider supplies a fresh token, explicitly per check.
/// This crate never executes gh, reads Keychain, inspects environment credentials,
/// migrates saved access, logs secrets or persists them. Not Debug or Clone.
pub struct ApprovedAccess(CString);

impl ApprovedAccess {
    /// Caller must establish approval and provenance for this exact repository first.
    pub fn from_approved_provider(token: &str) -> Result<Self, Error> {
        if token.is_empty()
            || token.len() > 65536
            || !token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(Error::Authentication);
        }
        Ok(Self(
            CString::new(token).map_err(|_| Error::Authentication)?,
        ))
    }
}

/// !Send + !Sync. Retain and release with the AppKit main-thread lifetime.
/// Native callbacks do not call Rust or hold GPUI borrows. Drain `take_completion`
/// on an integration-owned wakeup. `None` does not mean a check completed.
pub struct MacOS {
    handle: Option<NonNull<c_void>>,
    access: Option<ApprovedAccess>,
    _main_thread: PhantomData<Rc<()>>,
    _wake: Box<Wake>,
}

struct Wake(Rc<dyn Fn()>);

extern "C" fn wake(context: *mut c_void) {
    // SAFETY: stable Box retained until native teardown revokes all future callbacks.
    let callback = unsafe { &*context.cast::<Wake>() }.0.clone();
    // Never unwind over Objective-C. Integration only schedules, never borrows the updater here.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback()));
}

impl MacOS {
    /// `expected_bundle_id` must come from the Rust app's compiled identity contract,
    /// NOT from an arbitrary feed, URL or mutable user preference. Dev builds fail closed.
    pub fn new(
        expected_bundle_id: &str,
        schedule_wakeup: impl Fn() + 'static,
    ) -> Result<Self, Error> {
        // SAFETY: thread query has no side effects and takes no pointer.
        if !unsafe { pnu_is_main_thread() } {
            return Err(Error::Native);
        }
        let identity = CString::new(expected_bundle_id).map_err(|_| Error::Identity)?;
        let mut context = Box::new(Wake(Rc::new(schedule_wakeup)));
        // SAFETY: main-thread checked above; C consumes string synchronously.
        let handle = NonNull::new(unsafe {
            pnu_create(identity.as_ptr(), wake, (&mut *context as *mut Wake).cast())
        })
        .ok_or(Error::Unconfigured)?;
        Ok(Self {
            handle: Some(handle),
            access: None,
            _main_thread: PhantomData,
            _wake: context,
        })
    }

    pub fn supply_access(&mut self, access: ApprovedAccess) {
        self.access = Some(access);
    }

    pub fn take_completion(&mut self) -> Option<Completion> {
        let handle = self.handle?;
        let mut event = Event {
            operation: 0,
            kind: 0,
            error: 0,
            version: [0; 81],
        };
        // SAFETY: !Send lifetime is main-thread-only; native writes fixed-size Event.
        if !unsafe { pnu_take_event(handle.as_ptr(), &mut event) } {
            return None;
        }
        let outcome = match event.kind {
            1 => Outcome::Current,
            2 => {
                let bytes: Vec<u8> = event
                    .version
                    .iter()
                    .take_while(|&&b| b != 0)
                    .map(|&b| b as u8)
                    .collect();
                match String::from_utf8(bytes) {
                    Ok(version) if !version.is_empty() => Outcome::Available(Candidate { version }),
                    _ => Outcome::Failed(Error::InvalidResponse),
                }
            }
            4 => Outcome::Cancelled,
            _ => Outcome::Failed(error(event.error)),
        };
        Some(Completion {
            operation: event.operation,
            outcome,
        })
    }
}

impl Backend for MacOS {
    fn check(&mut self, operation: u64, _trigger: Trigger) -> Result<(), Error> {
        let handle = self.handle.ok_or(Error::Stopped)?;
        let access = self.access.take().ok_or(Error::Authentication)?;
        // SAFETY: native synchronously copies token. It never forwards it to Sparkle/CDN.
        let result = unsafe { pnu_check(handle.as_ptr(), operation, access.0.as_ptr()) };
        if result == 0 {
            Ok(())
        } else {
            Err(error(result))
        }
    }

    fn cancel(&mut self, operation: u64) {
        if let Some(handle) = self.handle {
            // SAFETY: handle remains retained until teardown, main-thread-only.
            unsafe { pnu_cancel(handle.as_ptr(), operation) };
        }
    }

    fn install_support(&self) -> Result<(), Error> {
        Err(Error::TransportUnavailable)
    }

    fn install(
        &mut self,
        _operation: u64,
        _candidate: &Candidate,
        _safety: Safety,
    ) -> Result<(), Error> {
        // A caller-provided boolean cannot enable unverified network/install authority.
        Err(Error::TransportUnavailable)
    }

    fn teardown(&mut self) {
        self.access = None;
        if let Some(handle) = self.handle.take() {
            // SAFETY: exactly one retained native owner, no Rust callbacks or borrowed pointers.
            unsafe { pnu_destroy(handle.as_ptr()) };
        }
    }
}

impl Drop for MacOS {
    fn drop(&mut self) {
        self.teardown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_explicit_bounded_and_never_debug() {
        for token in ["", " has-space", "line\nbreak", "\0", "é"] {
            assert!(ApprovedAccess::from_approved_provider(token).is_err());
        }
        assert!(ApprovedAccess::from_approved_provider("synthetic-test-token").is_ok());
        assert!(ApprovedAccess::from_approved_provider(&"x".repeat(65537)).is_err());
    }

    #[test]
    fn unbundled_check_does_not_touch_credentials_network_or_installer() {
        // Test threads are not AppKit's main thread; no native owner is constructed.
        assert!(MacOS::new("com.example.synthetic.next", || {}).is_err());
    }
}
