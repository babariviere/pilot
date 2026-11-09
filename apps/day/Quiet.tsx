// Nothing waits.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("quiet");
mount(() => <DayScreen day={day} />);
