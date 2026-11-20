// Test-only connected feedback adapter over the injected native host channel.
import { mount } from "nsh";
import { openDay } from "./app/testing/mockFeeds";
import { FeedbackScreen } from "./feedback/FeedbackScreen";
import { ConnectedFeedback, mirrorFeedback } from "./feedback/feedbackFeed";

const day = { ...openDay(), feedback: mirrorFeedback(new ConnectedFeedback("fixture")) };
mount(() => <FeedbackScreen day={day} />);
