-- Vetoes per (repo, node) (node #240): node ids collide across maps on
-- different repos. A row from before carries repo '' and still vetoes the
-- node on every repo, as it did.
CREATE TABLE vetoes_repo (repo text NOT NULL, node_id text NOT NULL, root integer,
comment_id text NOT NULL, proposal_comment_id text, at text NOT NULL, detail text,
PRIMARY KEY (repo, node_id));
--> statement-breakpoint
INSERT INTO vetoes_repo (repo, node_id, root, comment_id, proposal_comment_id, at, detail)
SELECT '', node_id, NULL, comment_id, NULL, at, detail FROM vetoes;
--> statement-breakpoint
DROP TABLE vetoes;
--> statement-breakpoint
ALTER TABLE vetoes_repo RENAME TO vetoes;
