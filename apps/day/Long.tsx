// A mission interview with 40 questions, the most one round holds.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./app/testing/mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("long");
mount(() => <MockDayScreen day={day} plans={plans} />);
