import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { changes, day, plans } from "./session";

mount(() => <DayScreen day={day} plans={plans} changes={changes} />);
