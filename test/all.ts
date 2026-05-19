// Entry point. Loads every test file (which registers its cases with
// the runner) then executes them.
import "./connect.test";
import "./request.test";
import "./reconnect.test";
import "./frame.test";
import "./auth.test";
import "./lifecycle.test";

import { runAll } from "./runner";

runAll();
