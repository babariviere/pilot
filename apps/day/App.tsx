// The app's default entry: Pilot on the service this window's native root
// chose. Without a root (`nsh run`), it says it is not connected and shows
// no examples. Mock scenarios are test fixtures (MockApp.tsx and others).
// It mounts here, not in an imported module, so the theme is set first.
import { mount } from "nsh";
import { Connected } from "./ConnectedDay";

mount(() => <Connected />);
