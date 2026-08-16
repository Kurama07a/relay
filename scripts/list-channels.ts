/**
 * Prints the channel IDs the bot can see, so you can fill in CLIENT_CHANNELS
 * and INTERNAL_CHANNEL without digging through the Slack UI.
 *
 *   npm run channels
 *
 * Deliberately reads SLACK_BOT_TOKEN straight from the environment rather than
 * going through src/config.ts — this needs to work before .env is complete.
 */
import "dotenv/config";
import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN?.trim();
if (!token) {
  console.error("SLACK_BOT_TOKEN is not set. Add it to .env first.");
  process.exit(1);
}

const client = new WebClient(token);

interface Row {
  id: string;
  name: string;
  member: boolean;
  shared: boolean;
  private: boolean;
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    for (const channel of result.channels ?? []) {
      if (!channel.id) continue;
      rows.push({
        id: channel.id,
        name: channel.name ?? "(unnamed)",
        member: Boolean(channel.is_member),
        shared: Boolean(channel.is_shared || channel.is_ext_shared),
        private: Boolean(channel.is_private),
      });
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  rows.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));

  const width = Math.max(...rows.map((row) => row.name.length), 4);
  console.log(`\n${"CHANNEL".padEnd(width)}  ID           FLAGS`);
  console.log("-".repeat(width + 30));

  for (const row of rows) {
    const flags = [
      row.member ? "bot-is-member" : "NOT-A-MEMBER",
      row.shared ? "slack-connect" : "",
      row.private ? "private" : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`${row.name.padEnd(width)}  ${row.id.padEnd(11)}  ${flags}`);
  }

  console.log(
    "\nInvite the bot to any channel marked NOT-A-MEMBER with /invite @relay before using it.\n",
  );
}

main().catch((error: unknown) => {
  const reason = (error as { data?: { error?: string } })?.data?.error ?? error;
  console.error("Failed to list channels:", reason);
  process.exit(1);
});
