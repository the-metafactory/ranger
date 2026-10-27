export const userJwt = (claims: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
export const creds = (jwt: string) => `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSU${"A".repeat(56)}\n------END USER NKEY SEED------\n`;
export const accountCreds = (issuerAccount: string) => creds(userJwt({ iss: issuerAccount, sub: `U${"A".repeat(55)}`, nats: { type: "user" } }));
