/**
 * Loaded before every test file (bunfig.toml). The supervisor runs this repo's
 * tests with RANGER_JOURNAL_PATH set to its session journal (node #66); left
 * in place, every config the tests build would share that one file. Tests get
 * their own temp journals, and the live directory is refused under test, so
 * the override is dropped here. A test that exercises it passes its own env.
 *
 * RANGER_UNDER_TEST marks test mode whatever NODE_ENV says: `bun test` keeps
 * a NODE_ENV the caller set, so NODE_ENV=production bun test would otherwise
 * default an unset state.journalPath to the live journal.
 */
delete process.env.RANGER_JOURNAL_PATH;
delete process.env.RANGER_TEST_ALLOW_LIVE_JOURNAL;
process.env.RANGER_UNDER_TEST = "1";
