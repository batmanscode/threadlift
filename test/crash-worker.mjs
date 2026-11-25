// Test-only subprocess: terminate without executing finally blocks.
import { applyJob } from '../src/target.mjs';
await applyJob(process.argv[2], {
  afterFile: process.argv[3] === 'file' ? () => process.exit(91) : undefined,
  afterCommit: process.argv[3] === 'commit' ? () => process.exit(91) : undefined,
});
