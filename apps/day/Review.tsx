// A finished interview whose plan waits for the user's review: the full
// spec, testing, slices with their order and owners, and open fog.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("review");
mount(() => <MockDayScreen day={day} plans={plans} />);
