// Test fixture only: the decisions world over mock feeds, for the headless
// *.test.tsx files. Every mission, task and count is invented. The app's
// entry is App.tsx.
import { mount } from "nsh";
import { MockDayScreen } from "./mockFeeds";
import { changes, day, plans, update } from "./mockSession";

mount(() => <MockDayScreen day={day} plans={plans} changes={changes} update={update} />);
