// Point a copied ranger.yaml at the snapshot journal, so no process that reads
// this config can fall back to the live ~/.config/ranger/state.sqlite.
// usage: bun pin-journal.ts <ranger.yaml> <journal.sqlite>
import { parseDocument } from "yaml";

const [config, journal] = Bun.argv.slice(2);
if (!config || !journal) throw new Error("usage: bun pin-journal.ts <ranger.yaml> <journal.sqlite>");
const doc = parseDocument(await Bun.file(config).text());
doc.setIn(["state", "journalPath"], journal);
await Bun.write(config, doc.toString());
const written = parseDocument(await Bun.file(config).text()).getIn(["state", "journalPath"]);
if (written !== journal) throw new Error(`journalPath is ${String(written)}, expected ${journal}`);
