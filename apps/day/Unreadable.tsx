// Nothing could be read and no earlier read exists: Today says so.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("unreadable");
mount(() => <DayScreen day={day} />);
