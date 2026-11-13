// The large world with the shared update workload running: one whole-model
// change every 100 ms, 300 times (`Desk::pulse`; the Rust screen's
// `PulseApp` runs the same).
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("large");
void day.feed.pulse();
mount(() => <MockDayScreen day={day} />);
