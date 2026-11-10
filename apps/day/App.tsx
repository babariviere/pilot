import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { changes, day, plans, update } from "./session";

mount(() => <DayScreen day={day} plans={plans} changes={changes} update={update} />);
