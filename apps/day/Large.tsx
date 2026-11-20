// The decisions world with 200 more missions and 120 more results.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";

const day = openDay("large");
mount(() => <MockDayScreen day={day} />);
