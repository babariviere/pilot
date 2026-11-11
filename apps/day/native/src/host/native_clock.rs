//! macOS system time, independent of TZ, locale, JS and launch environment.
use super::{Error, ritual::LocalDay};
use nsh_platform_macos::objc2::rc::autoreleasepool;
use objc2_foundation::{
    NSCalendar, NSCalendarIdentifierGregorian, NSCalendarUnit, NSDate, NSString, NSTimeZone,
};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

fn zone_name(path: &Path) -> Result<String, Error> {
    // Read the OS-managed link, not libc's environment-sensitive localtime or
    // Foundation's process-default zone. Do not guess UTC if it is absent.
    let zone = ["/var/db/timezone/zoneinfo", "/usr/share/zoneinfo"]
        .iter()
        .find_map(|root| path.strip_prefix(root).ok())
        .and_then(Path::to_str)
        .ok_or(Error::Unavailable)?;
    if zone.is_empty()
        || zone.len() > 128
        || !zone.split('/').all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
        })
    {
        return Err(Error::Unavailable);
    }
    Ok(zone.into())
}

fn at(time: SystemTime, name: &str) -> Result<LocalDay, Error> {
    let elapsed = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Unavailable)?;
    let unix_ms = u64::try_from(elapsed.as_millis()).map_err(|_| Error::Unavailable)?;
    autoreleasepool(|_| {
        let zone =
            NSTimeZone::timeZoneWithName(&NSString::from_str(name)).ok_or(Error::Unavailable)?;
        // SAFETY: Apple's immutable exported Gregorian calendar identifier.
        let calendar = NSCalendar::calendarWithIdentifier(unsafe { NSCalendarIdentifierGregorian })
            .ok_or(Error::Unavailable)?;
        calendar.setTimeZone(&zone);
        let date = NSDate::dateWithTimeIntervalSince1970(elapsed.as_secs_f64());
        let parts = calendar.components_fromDate(
            NSCalendarUnit::Year
                | NSCalendarUnit::Month
                | NSCalendarUnit::Day
                | NSCalendarUnit::Hour,
            &date,
        );
        let day = LocalDay {
            date: format!(
                "{:04}-{:02}-{:02}",
                parts.year(),
                parts.month(),
                parts.day()
            ),
            time_zone: name.into(),
            hour: u8::try_from(parts.hour()).map_err(|_| Error::Unavailable)?,
            unix_ms,
        };
        day.validate()?;
        Ok(day)
    })
}

pub(super) fn sample() -> Result<LocalDay, Error> {
    let link = || std::fs::read_link("/etc/localtime").map_err(|_| Error::Unavailable);
    let before = link()?;
    let name = zone_name(&before)?;
    let day = at(SystemTime::now(), &name)?;
    // A zone changed during the sample is not an authoritative mixed sample.
    if link()? != before {
        return Err(Error::Unavailable);
    }
    Ok(day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn native_calendar_uses_exact_instant_and_named_zone_including_dst() {
        let instant = UNIX_EPOCH + Duration::from_secs(1_782_984_300); // 2026-07-02 09:25Z
        let paris = at(instant, "Europe/Paris").unwrap();
        let new_york = at(instant, "America/New_York").unwrap();
        assert_eq!(paris.date, "2026-07-02");
        assert_eq!(new_york.date, "2026-07-02");
        assert_eq!(paris.hour, 11);
        assert_eq!(new_york.hour, 5);
        assert_eq!(paris.unix_ms, 1_782_984_300_000);
        let midnight = at(
            UNIX_EPOCH + Duration::from_secs(1_783_034_700),
            "America/New_York",
        )
        .unwrap();
        assert_ne!(
            midnight.date,
            at(
                UNIX_EPOCH + Duration::from_secs(1_783_034_700),
                "Europe/Paris"
            )
            .unwrap()
            .date
        );
        assert!(at(UNIX_EPOCH - Duration::from_secs(1), "Europe/Paris").is_err());
        assert!(at(instant, "Missing/Zone").is_err());
    }

    #[test]
    fn only_system_zoneinfo_links_supply_zone_names() {
        assert_eq!(
            zone_name(Path::new("/var/db/timezone/zoneinfo/Europe/Paris")).unwrap(),
            "Europe/Paris"
        );
        for path in [
            "Europe/Paris",
            "/tmp/Europe/Paris",
            "/usr/share/zoneinfo/../UTC",
            "/usr/share/zoneinfo",
        ] {
            assert!(zone_name(Path::new(path)).is_err(), "{path}");
        }
    }

    #[test]
    fn production_source_reads_the_os_zone_and_wall_clock() {
        let source = super::super::ritual::DaySource::system();
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let day = (source.clock)().unwrap();
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        assert!((before..=after).contains(&u128::from(day.unix_ms)));
        assert_eq!(
            day.time_zone,
            zone_name(&std::fs::read_link("/etc/localtime").unwrap()).unwrap()
        );
    }

    #[test]
    fn process_zone_overrides_never_supply_production_time() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host::native_clock::tests::production_source_reads_the_os_zone_and_wall_clock",
            ])
            .env("TZ", "Pacific/Honolulu")
            .env("PILOT_DAY_DATE", "2099-01-01")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
