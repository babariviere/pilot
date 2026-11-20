//! The screen agent's picture of its own window, taken the way NSH 0.5.0's `synth::shot` does:
//! the window server's composited image of this window (`CGWindowListCreateImageFromArray`,
//! looked up at run time), or AppKit's in-process drawing (`cacheDisplayInRect:`) where that
//! fails. Neither needs the Screen Recording permission. Main thread only; the PNG is encoded
//! there too, as AppKit's encoder needs the bitmap.
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    rc::{Rc, Weak},
    sync::Arc,
};

use dispatch2::DispatchQueue;
use nsh_platform_macos::{
    AppView,
    objc2::{AnyThread, MainThreadMarker, rc::Retained, runtime::AnyObject},
    objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSScreen, NSWindow,
    },
    objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize},
};

use crate::{
    bridge::Bridge,
    host::{
        Error,
        screen::{Picture, Taker},
    },
};

thread_local! {
    /// Main-thread routing from a window ID to its view, never "the current window".
    static VIEWS: RefCell<HashMap<String, Weak<AppView>>> = RefCell::new(HashMap::new());
}

/// Gives this window's host a camera of its own window.
pub(crate) fn register(bridge: &Bridge, view: &Rc<AppView>) {
    let id = bridge.window_identity().to_owned();
    VIEWS.with(|views| views.borrow_mut().insert(id.clone(), Rc::downgrade(view)));
    let taker: Taker = Arc::new(move |reply| {
        let id = id.clone();
        DispatchQueue::main().exec_async(move || {
            let view = VIEWS.with(|views| {
                let mut views = views.borrow_mut();
                let view = views.get(&id).and_then(Weak::upgrade);
                if view.is_none() {
                    views.remove(&id);
                }
                view
            });
            let result = view
                .and_then(|view| view.view().window())
                .ok_or(Error::Unavailable)
                .and_then(|window| shot(&window));
            if let Err(error) = &result {
                crate::day_log::event(
                    "screen.picture_failed",
                    serde_json::json!({"error": error.to_string()}),
                );
            }
            let _ = reply.try_send(result);
        });
    });
    bridge.set_screen_picture(taker);
}

fn shot(window: &NSWindow) -> Result<Picture, Error> {
    let rep = composited(window).or_else(|_| drawn(window))?;
    let width = u32::try_from(rep.pixelsWide()).map_err(|_| Error::Invalid)?;
    let height = u32::try_from(rep.pixelsHigh()).map_err(|_| Error::Invalid)?;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    // SAFETY: an empty property dictionary is valid for PNG.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) };
    Ok(Picture {
        png: data.ok_or(Error::Unavailable)?.to_vec(),
        width,
        height,
    })
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayCreate(
        allocator: *const c_void,
        values: *const *const c_void,
        count: isize,
        callbacks: *const c_void,
    ) -> *const c_void;
    fn CFRelease(value: *const c_void);
}
/// `CGWindowListCreateImageFromArray`: deprecated and missing from recent SDK headers, but
/// still exported, so it is looked up at run time.
type CreateImageFromArray = unsafe extern "C" fn(NSRect, *const c_void, u32) -> *mut c_void;
/// `kCGWindowImageBestResolution`: pixels at the display's backing scale.
const IMAGE_BEST_RESOLUTION: u32 = 1 << 3;

/// The window's content as the window server composited it, with its sheets and child windows.
fn composited(window: &NSWindow) -> Result<Retained<NSBitmapImageRep>, Error> {
    if !window.isVisible() {
        return Err(Error::Unavailable);
    }
    // SAFETY: dlsym with RTLD_DEFAULT and a NUL-terminated name only looks the symbol up.
    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"CGWindowListCreateImageFromArray".as_ptr(),
        )
    };
    if symbol.is_null() {
        return Err(Error::Unavailable);
    }
    // SAFETY: the symbol is CoreGraphics' function of this signature.
    let create: CreateImageFromArray = unsafe { std::mem::transmute(symbol) };
    let view = window.contentView().ok_or(Error::Unavailable)?;
    let main = MainThreadMarker::from(window);
    let primary = NSScreen::screens(main)
        .firstObject()
        .ok_or(Error::Unavailable)?
        .frame();
    let frame = window.convertRectToScreen(view.convertRect_toView(view.bounds(), None));
    // Screen coordinates from the primary screen's top left, as the window server's.
    let rect = NSRect::new(
        NSPoint::new(
            frame.origin.x,
            primary.size.height - frame.origin.y - frame.size.height,
        ),
        NSSize::new(frame.size.width, frame.size.height),
    );
    let mut ids = Vec::new();
    front_to_back(window, &mut ids);
    let values: Vec<*const c_void> = ids.iter().map(|&id| id as usize as *const c_void).collect();
    // SAFETY: an array of window numbers as plain values (no callbacks), as the function takes
    // them. `values` outlives the call that copies them.
    let array = unsafe {
        CFArrayCreate(
            std::ptr::null(),
            values.as_ptr(),
            values.len() as isize,
            std::ptr::null(),
        )
    };
    if array.is_null() {
        return Err(Error::Unavailable);
    }
    // SAFETY: a rectangle, an array of window numbers and options; returns a +1 image or null.
    let image = unsafe { create(rect, array, IMAGE_BEST_RESOLUTION) };
    // SAFETY: the array was created above and is released once.
    unsafe { CFRelease(array) };
    if image.is_null() {
        return Err(Error::Unavailable);
    }
    // SAFETY: a valid CGImage the caller owns; the bitmap retains it, then it is released once.
    let rep =
        NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), unsafe { &*image.cast() });
    unsafe { CFRelease(image) };
    if blank(&rep) {
        // A locked screen, or a window the window server has no surface of.
        return Err(Error::Unavailable);
    }
    Ok(rep)
}

/// `window`, its sheets and its visible child windows, frontmost first.
fn front_to_back(window: &NSWindow, ids: &mut Vec<u32>) {
    if let Some(sheet) = window.attachedSheet() {
        front_to_back(&sheet, ids);
    }
    if let Some(children) = window.childWindows() {
        for child in children.to_vec().iter().rev() {
            if child.isVisible() {
                front_to_back(child, ids);
            }
        }
    }
    let id = window.windowNumber() as u32;
    if !ids.contains(&id) {
        ids.push(id);
    }
}

/// Whether a 32-bit bitmap has only black or clear pixels, judged on a 32 by 32 grid. A black
/// or clear pixel has at most one byte that is not zero (its alpha). Other formats count as drawn.
fn blank(rep: &NSBitmapImageRep) -> bool {
    const SIDE: isize = 32;
    let (width, height, row) = (rep.pixelsWide(), rep.pixelsHigh(), rep.bytesPerRow());
    if width <= 0 || height <= 0 {
        return true;
    }
    let data = rep.bitmapData();
    if data.is_null() || rep.isPlanar() || rep.bitsPerPixel() != 32 || row < width * 4 {
        return false;
    }
    (0..SIDE).all(|y| {
        (0..SIDE).all(|x| {
            let offset = (y * height / SIDE) * row + (x * width / SIDE) * 4;
            // SAFETY: the offset is inside the bitmap: rows are `row` bytes, pixels 4 bytes.
            let pixel = unsafe { std::slice::from_raw_parts(data.offset(offset), 4) };
            pixel.iter().filter(|&&b| b != 0).count() <= 1
        })
    })
}

/// The window's content as AppKit draws it in process. Works wherever the window is.
fn drawn(window: &NSWindow) -> Result<Retained<NSBitmapImageRep>, Error> {
    let view = window.contentView().ok_or(Error::Unavailable)?;
    let bounds = view.bounds();
    let rep = view
        .bitmapImageRepForCachingDisplayInRect(bounds)
        .ok_or(Error::Unavailable)?;
    view.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
    Ok(rep)
}
