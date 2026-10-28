# Observation intake

The principal can file new work by mentioning the bot in a map's Discord thread. Ranger turns each mention into a draft node card. A 👍 on the card files the node, and a ❌ discards it. This page follows a mention from the read to the filed node.

## Read the mentions

Each walk tick reads the Discord thread of every map that has one and is not `walk: none` (node #247, #21 rulings D3, D11, D12, and D17). Ranger reads over REST, without the gateway. A message counts only when `principal.discordId` wrote it and its text @-mentions the bot. Ranger reads the bot's id once per tick from `GET /users/@me`. Without `principal.discordId`, ranger reads no thread.

The journal keeps a cursor per thread and one draft per message id, so reading a message again posts no second card. A failed read posts nothing and does not move the cursor. When Discord withholds a mention's content, ranger stops reading that thread at that mention and reports it. The mentions before it are still drafted.

Ranger skips a thread that two walked maps share. A draft's parent is its map's root, and a shared thread does not name one map.

## Draft a node

Each mention gets a draft card in its thread, posted as a reply to the mention.

With spawn budget left, one `claude -p` call without tools drafts the node (node #252, #21 ruling D12). It runs on `intake.model` (default `haiku`), and its cost is charged to the spawn ledger. The model sees the message and the map's open nodes: the root and the frontier that the walk cached. The message and the node titles reach the model only as JSON data. Ranger parses the answer and never runs it.

The draft must pass these checks:

- The parent is one of those open nodes.
- The autonomy is `auto`, `propose`, or `approve`.
- The kind is `research`, `prototype`, `grilling`, `task`, or `build`.
- The checkpoint is a slug.
- Each probe is a soma probe.

When the budget is spent, the call fails, times out, or returns something other than JSON, or any field fails its check, ranger uses the whole deterministic draft instead. The deterministic drafter takes the message verbatim with a link to it, a title from its first line, the map root as parent, a checkpoint slugged from the title, and autonomy `propose`. Each card says "drafted by claude" or "deterministic draft", and why. When too little of the pass is left for a call, the rest of the thread waits for the next tick. The journal records the whole drafted spec and its hash (migration 0026).

## Correct a draft

To change a draft, the principal replies to the current card with a bot @-mention that names the changes, for example "parent #40, kind build" (node #241, #21 ruling D13). Claude applies the reply to the previous spec. When it cannot, ranger reads `parent #N`, `kind <k>`, `autonomy <a>`, `title: <text>`, and `checkpoint <slug>` from the reply. A field that ranger does not understand keeps its previous value, and the card says so.

Ranger posts a new draft card, as a reply to the correction, with the corrected spec and its own spec hash. It edits the old card to "superseded → <link>". The old row moves from `superseding` to `superseded`, and ranger never reads its reactions again, so only a 👍 on the newest card files the node. The chain keeps the mention's body, link, and marker, so one observation files at most one node.

A reply to a superseded, filed, or discarded card changes nothing. Neither does a reply from anyone else, or a reply without a bot mention.

## File or discard a draft

The same tick reads the 👍 and ❌ reactions on each open draft card, at most 10 per thread, least recently read first (node #251, #21 rulings D4, D5, D13, and D14, and D1).

A ❌ from `principal.discordId` discards the draft and edits the card to "discarded". A ❌ wins over a 👍.

A 👍 from the principal files the draft when all of these hold:

- The journaled spec still hashes to the hash that the card shows.
- The write identity passes `assertWriteIdentity`.
- The autonomy is `propose` or `approve`.
- No issue that the machine account wrote with the label `ranger:principal-intake` already ends in `<!-- ranger:intake discord=<msgId> -->`. Ranger lists the labelled issues once per thread per tick.

Ranger then runs `soma graph add <parent> --json` under the journaled parent, as the machine account, with the label `ranger:principal-intake`. The body holds the message verbatim, a link to it, and the marker as its last line. Ranger edits the card to "filed as #N".

The row moves to `filing` before the add. If a tick dies after the add, the next tick finds the node by its marker and links it under its parent, which does nothing when it is already attached. It does not add a second node. A failed reaction read, identity check, or marker lookup files nothing that tick. Ranger ignores a 👍 from anyone else. The tracker's node and its marker are the record. The journal is a cache.

## Recover from a lost journal

A thread with no cursor is read from its oldest message, five pages per tick (node #249, #21 ruling D14, D1). A mention without a journaled draft is drafted again, unless a ranger card that replies to it says "filed as #N" or "discarded". A card still in draft does not count.

A mention is settled once a read has seen the end of the thread, or a whole page past the mention. Until then, the cursor waits just before it. The worst case is a duplicate draft that you can see. A 👍 on that duplicate finds the intake marker and edits the card to "filed as #N" without adding a second node.

The journal cannot tell a lost cursor from a thread that was never read. If you turn intake on for a thread that already holds the principal's @-mentions of the bot, ranger drafts each mention that no ranger card has answered. That is one card per past mention, and each is filed only on a 👍.
