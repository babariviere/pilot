// The connected entry: Day on the Pilot service this window's native root
// chose, never mock data. Without a root (`nsh run Connected.tsx`), it says
// it is not connected and shows nothing else. App.tsx, the default entry,
// mounts the same window (ConnectedDay.tsx).
import { mount } from "nsh";
import { Connected } from "./app/ConnectedDay";

mount(() => <Connected />);
