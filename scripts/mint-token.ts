/**
 * Issues, lists, and revokes API tokens for engineers.
 *
 *   npm run token -- --user U0123ABCD --label "sam-laptop"
 *   npm run token -- --list
 *   npm run token -- --revoke 3
 *
 * The plaintext token is printed once and never stored — only its hash lands in
 * the database, so a leaked relay.db is not a set of working credentials.
 */
import "dotenv/config";
import { listTokens, mintToken, revokeToken } from "../src/tokens.js";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

if (args.includes("--list")) {
  const tokens = listTokens();
  if (tokens.length === 0) {
    console.log("\nNo tokens issued. Relay will accept unauthenticated loopback calls.\n");
  } else {
    console.log("\n ID  SLACK USER    LABEL                 LAST USED             STATE");
    console.log("─".repeat(76));
    for (const token of tokens) {
      console.log(
        ` ${String(token.id).padEnd(3)} ${token.slack_user_id.padEnd(13)} ` +
          `${(token.label ?? "—").padEnd(21)} ${(token.last_used_at ?? "never").slice(0, 19).padEnd(21)} ` +
          `${token.revoked_at ? "revoked" : "active"}`,
      );
    }
    console.log();
  }
  process.exit(0);
}

const revokeId = flag("revoke");
if (revokeId) {
  const ok = revokeToken(Number(revokeId));
  console.log(ok ? `Token ${revokeId} revoked.` : `No active token with id ${revokeId}.`);
  process.exit(ok ? 0 : 1);
}

const user = flag("user");
if (!user) {
  console.error(`
Usage:
  npm run token -- --user U0123ABCD [--label "sam-laptop"]
  npm run token -- --list
  npm run token -- --revoke <id>

Find a Slack user ID from the member's profile → More → Copy member ID.
`);
  process.exit(1);
}

const label = flag("label");
const token = mintToken(user, label);

console.log(`
Token issued for ${user}${label ? ` (${label})` : ""}.

Give this to the engineer — it is not recoverable, and this is the only time
it will be shown:

  RELAY_TOKEN=${token}

Note: issuing the first token switches the API into authenticated mode. Every
caller now needs a token, including anything on the server itself.
`);
