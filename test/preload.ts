/**
 * Loaded before every test file (bunfig.toml). The supervisor runs this repo's
 * tests with RANGER_JOURNAL_PATH set to its session journal (node #66); left
 * in place, every config the tests build would share that one file. Tests get
 * their own temp journals, and the live directory is refused under test, so
 * the override is dropped here. A test that exercises it passes its own env.
 */
delete process.env.RANGER_JOURNAL_PATH;
delete process.env.RANGER_TEST_ALLOW_LIVE_JOURNAL;
