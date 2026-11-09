// The decisions world with 200 more missions and 120 more results.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("large");
mount(() => <DayScreen day={day} />);
