// Fixture-only local demo. No normal .env or external provider is loaded.
import { bootScratchApp } from './harness/scratch.js';
const demo = await bootScratchApp();
console.log(`Fixture demo: ${demo.base}/`);
console.log('Create a demo account in the browser. Mail and DNS are simulated; no email is sent. Neo4j is unconfigured in this mode.');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async()=>{await demo.close();process.exit(0);});
