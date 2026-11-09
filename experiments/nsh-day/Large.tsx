// The decisions world with 200 more missions and 120 more results.
import { mount } from "nsh";
import { openDay } from "./day";
import { TodayScreen } from "./TodayScreen";

const day = openDay("large");
mount(() => <TodayScreen day={day} />);
