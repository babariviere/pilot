//! Only canonical Local chat links are navigation authority.
pub(crate) fn target(url: &str) -> Result<&str, &'static str> {
    let id = url
        .strip_prefix("pilot://chat/")
        .ok_or("Use a Pilot chat link: pilot://chat/<id>.")?;
    if !crate::local_model::valid_id(id) {
        return Err("Invalid chat link. Copy the complete pilot://chat/<id> link.");
    }
    Ok(id)
}

#[cfg(test)]
#[path = "chat_links_tests.rs"]
mod tests;
