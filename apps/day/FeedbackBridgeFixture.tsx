// Test-only connected feedback adapter over the injected native host channel.
import { mount } from "nsh";
import { FeedbackScreen } from "./FeedbackScreen";
import { ConnectedFeedback, mirrorFeedback } from "./feedbackFeed";
import { openDay } from "./mockFeeds";

const day = { ...openDay(), feedback: mirrorFeedback(new ConnectedFeedback("fixture")) };
mount(() => <FeedbackScreen day={day} />);
