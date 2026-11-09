import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { day, plans } from "./session";

mount(() => <DayScreen day={day} plans={plans} />);
