// The entry nsh needs to check and test this project; Pilot never loads it. The examples import Day's component
// library (`pilot-day/ui`), whose fonts and icons sit outside this project, so they cannot be bundled here: they run
// in Day's artifact runtime tests (apps/day/native/tests/artifact_examples.rs).
import { mount, Text } from "nsh";

mount(() => <Text>See apps/day/native/tests/artifact_examples.rs for the examples.</Text>);
