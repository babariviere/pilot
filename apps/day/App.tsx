import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { day } from "./session";

mount(() => <DayScreen day={day} />);
