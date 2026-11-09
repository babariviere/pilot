import { mount } from "nsh";
import { day } from "./session";
import { TodayScreen } from "./TodayScreen";

mount(() => <TodayScreen day={day} />);
