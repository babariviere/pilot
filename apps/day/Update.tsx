// The default world with an app and service update ready: two agents work
// and one is paused by the user. Updating saves every form and where the
// user is, pauses only the working agents, restarts and restores the
// window, then resumes only those agents. Mock data: nothing real updates.
import { mount } from "nsh";
import { MockDayScreen, openUpdate } from "./mockFeeds";
import { changes, day, plans } from "./mockSession";

const update = openUpdate("available");
mount(() => <MockDayScreen day={day} plans={plans} changes={changes} update={update} />);
