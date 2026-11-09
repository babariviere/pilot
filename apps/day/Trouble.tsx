// The trouble world: a failure whose confirmation is lost, and an
// unconfirmed push.
import { mount } from "nsh";
import { openDay } from "./day";
import { TodayScreen } from "./TodayScreen";

const day = openDay("trouble");
mount(() => <TodayScreen day={day} />);
