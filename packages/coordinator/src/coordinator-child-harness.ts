/** Test harness: the coordinator child entrypoint used by fork-ipc tests. */
import { runCoordinatorEntry, parseBootstrap } from "./entry.js";

runCoordinatorEntry(parseBootstrap(process.argv.slice(2)));
