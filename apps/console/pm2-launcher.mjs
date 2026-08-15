// pm2 entry: pm2's fork wrapper makes argv[1] its own wrapper script, so the
// CLI entry guard in dist/src/index.js never fires. Call main() explicitly.
import { main } from "./dist/src/index.js";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
