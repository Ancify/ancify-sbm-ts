// Entry point. Loads every test file (which registers its cases with
// the runner) then executes them.
import "./connect.test";
import "./request.test";
import "./reconnect.test";
import "./frame.test";
import "./auth.test";
import "./lifecycle.test";

// Phase 4 comprehensive suite.
import "./comprehensive/status-lifecycle.test";
import "./comprehensive/error-paths.test";
import "./comprehensive/protocol-edges.test";
import "./comprehensive/concurrency-stress.test";
import "./comprehensive/auth-scenarios.test";
import "./comprehensive/memory-hygiene.test";
import "./comprehensive/public-api.test";
import "./comprehensive/tls.test";

import { runAll } from "./runner";

runAll();
