// Nothing waits.
import { mount } from "nsh";
import { openDay } from "./day";
import { TodayScreen } from "./TodayScreen";

const day = openDay("quiet");
mount(() => <TodayScreen day={day} />);
