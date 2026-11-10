// The default world with an app and service update ready: two agents work
// and one is paused by the user. Updating saves every form and where the
// user is, pauses only the working agents, restarts and restores the
// window, then resumes only those agents. Mock data: nothing real updates.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { changes, day, plans } from "./session";
import { openUpdate } from "./updateFeed";

const update = openUpdate("available");
mount(() => <DayScreen day={day} plans={plans} changes={changes} update={update} />);
