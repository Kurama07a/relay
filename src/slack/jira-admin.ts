import type { KnownBlock, PlainTextOption, View } from "@slack/types";
import { app, client } from "./app.js";
import { actionContext, announce, denyIfNotAdmin, postingProblem } from "./admin.js";
import { channelName } from "./names.js";
import { dateRange, dot, ICON, truncate } from "./design.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { listRoutes, setJiraBoard, type Route } from "../routes.js";
import {
  activeSprint,
  assignableMembers,
  boardColumns,
  describeJiraError,
  jiraConfigured,
  listBoards,
  myself,
  type BoardColumn,
} from "../jira/client.js";
import {
  BUCKETS,
  BUCKET_LABEL,
  bucketsFor,
  guessBucket,
  isBucket,
  saveBuckets,
  savedBucketForColumn,
  seedBuckets,
} from "../jira/buckets.js";
import {
  linkProblems,
  listMembers,
  saveLinks,
  suggestLinks,
  syncMembers,
  unlinkSlackUser,
  type LinkChoice,
  type SlackPerson,
} from "../jira/members.js";
import { syncJiraNow } from "../jira/sync.js";

/**
 * Jira setup from inside Slack: which board a pairing follows, how that
 * board's columns map onto Relay's five groups, and who each Jira member is in
 * Slack. Everything here reads from Jira; nothing writes to it.
 */

const CONNECT_BOARD = "relay_jira_board";
const MAP_COLUMNS = "relay_jira_columns";
const LINK_MEMBERS = "relay_jira_members";

const plain = (text: string) => ({ type: "plain_text" as const, text });

function boardLabel(route: Route): string {
  return route.jira_board_name ?? `board ${route.jira_board_id}`;
}

/** The Jira part of `/relay setup`, shown to admins under the existing card. */
export async function jiraBlocks(): Promise<KnownBlock[]> {
  const blocks: KnownBlock[] = [{ type: "divider" }];

  if (!jiraConfigured()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Jira*\n_Not configured. Set JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server, then restart Relay._",
      },
    });
    return blocks;
  }

  const routes = listRoutes();
  const connected = routes.filter((route) => route.jira_board_id);
  const members = listMembers();
  const linked = members.filter((member) => member.slack_user).length;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Jira* · ${new URL(config.jira.url).host}` + (connected.length === 0 ? "\n_No board connected yet._" : ""),
    },
  });

  for (const route of connected) {
    const statuses = bucketsFor(route.jira_board_id!).length;
    blocks.push({
      type: "section",
      block_id: `jira_route_${route.id}`,
      text: {
        type: "mrkdwn",
        text:
          `*${boardLabel(route)}* (${route.jira_project_key}) → *${await channelName(route.client_channel)}*\n` +
          dot(
            route.sprint_channel
              ? `sprint threads in ${await channelName(route.sprint_channel)}`
              : "no sprint channel",
            statuses > 0 ? `${statuses} status${statuses === 1 ? "" : "es"} mapped` : "columns not mapped",
            `${linked} of ${members.length} members linked`,
          ),
      },
    });
    blocks.push({
      type: "actions",
      block_id: `jira_actions_${route.id}`,
      elements: [
        {
          type: "button",
          text: plain("Board columns"),
          action_id: "relay_open_jira_columns",
          value: String(route.id),
        },
        {
          type: "button",
          text: plain("Jira members"),
          action_id: "relay_open_jira_members",
          value: String(route.id),
        },
      ],
    });
  }

  if (routes.length === 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Add a channel pairing first. A Jira board is connected to a pairing." }],
    });
    return blocks;
  }

  blocks.push({
    type: "actions",
    block_id: "jira_connect",
    elements: [
      {
        type: "button",
        text: plain(connected.length > 0 ? "Change Jira board" : "Connect Jira board"),
        ...(connected.length > 0 ? {} : { style: "primary" as const }),
        action_id: "relay_open_jira_board",
      },
    ],
  });

  return blocks;
}

/**
 * Opens a modal straight away and fills it in once Jira has answered. Slack
 * trigger ids expire after three seconds, and a Jira round trip can take most
 * of that, so fetching first would fail some of the time.
 */
async function openWhileLoading(triggerId: string, title: string, build: () => Promise<View>): Promise<void> {
  const opened = await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      title: plain(title),
      close: plain("Cancel"),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "_Asking Jira…_" } }],
    },
  });
  const viewId = opened.view?.id;
  if (!viewId) return;

  let view: View;
  try {
    view = await build();
  } catch (error) {
    log.warn(`jira form "${title}" failed`, error);
    view = {
      type: "modal",
      title: plain(title),
      close: plain("Close"),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `${ICON.warning} ${describeJiraError(error)}` } }],
    };
  }

  await client.views.update({ view_id: viewId, hash: opened.view?.hash, view });
}

/** Board choices carry what the save needs, so it doesn't ask Jira again. */
type BoardChoice = [id: number, projectKey: string, name: string, type: string];

async function boardModal(): Promise<View> {
  const routes = listRoutes();
  const boards = await listBoards();
  if (boards.length === 0) throw new Error("This Jira account can't see any boards.");

  const current = routes.find((route) => route.jira_board_id) ?? routes[0];

  const routeOptions: PlainTextOption[] = await Promise.all(
    routes.map(async (route) => ({
      text: plain(truncate(`${await channelName(route.client_channel)} → ${await channelName(route.team_channel)}`, 75)),
      value: String(route.id),
    })),
  );
  const boardOptions: PlainTextOption[] = boards.slice(0, 100).map((board) => ({
    text: plain(
      truncate(
        `${board.name}${board.projectKey ? ` · ${board.projectKey}` : ""}${board.type === "kanban" ? " (no sprints)" : ""}`,
        75,
      ),
    ),
    value: JSON.stringify([board.id, board.projectKey ?? "", board.name.slice(0, 60), board.type] satisfies BoardChoice),
  }));

  const initialRoute = routeOptions.find((option) => option.value === String(current?.id));
  const initialBoard = boardOptions.find(
    (option) => (JSON.parse(option.value!) as BoardChoice)[0] === current?.jira_board_id,
  );

  return {
    type: "modal",
    callback_id: CONNECT_BOARD,
    title: plain("Connect Jira board"),
    submit: plain("Connect"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "route",
        label: plain("Pairing"),
        hint: plain("Internal story cards go to this pairing's team channel."),
        element: {
          type: "static_select",
          action_id: "value",
          options: routeOptions,
          ...(initialRoute ? { initial_option: initialRoute } : {}),
        },
      },
      {
        type: "input",
        block_id: "board",
        label: plain("Jira board"),
        element: {
          type: "static_select",
          action_id: "value",
          options: boardOptions,
          ...(initialBoard ? { initial_option: initialBoard } : {}),
        },
      },
      {
        type: "input",
        block_id: "sprint",
        label: plain("Sprint channel"),
        hint: plain("Client-facing: one thread per story. Invite Relay and the client's guests here."),
        element: {
          type: "conversations_select",
          action_id: "value",
          filter: { include: ["public", "private"], exclude_bot_users: true },
          ...(current?.sprint_channel ? { initial_conversation: current.sprint_channel } : {}),
        },
      },
    ],
  };
}

async function columnsModal(route: Route): Promise<View> {
  const boardId = route.jira_board_id!;
  const columns = (await boardColumns(boardId)).slice(0, 40);
  if (columns.length === 0) throw new Error("That board has no columns Relay can read.");

  const options: PlainTextOption[] = BUCKETS.map((bucket) => ({ text: plain(BUCKET_LABEL[bucket]), value: bucket }));

  return {
    type: "modal",
    callback_id: MAP_COLUMNS,
    private_metadata: JSON.stringify({ boardId, columns }),
    title: plain("Board columns"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Where each column of *${boardLabel(route)}* appears on the sprint board. Issues flagged in Jira always show as Blocked.`,
        },
      },
      ...columns.map(
        (column, index): KnownBlock => ({
          type: "input",
          block_id: `column_${index}`,
          label: plain(truncate(column.name, 200)),
          element: {
            type: "static_select",
            action_id: "value",
            options,
            initial_option: options.find((option) => option.value === savedBucketForColumn(boardId, column)),
          },
        }),
      ),
    ],
  };
}

/** Workspace members, kept briefly so the save can refuse guests and apps without asking Slack again. */
let peopleCache: { at: number; people: Map<string, SlackPerson> } | null = null;

async function slackPeople(): Promise<Map<string, SlackPerson>> {
  if (peopleCache && Date.now() - peopleCache.at < 10 * 60_000) return peopleCache.people;

  const people = new Map<string, SlackPerson>();
  let cursor: string | undefined;
  do {
    const page = await client.users.list({ limit: 200, cursor });
    for (const user of page.members ?? []) {
      if (!user.id) continue;
      people.set(user.id, {
        id: user.id,
        names: [user.real_name, user.profile?.real_name, user.profile?.display_name, user.name].filter(
          (name): name is string => Boolean(name?.trim()),
        ),
        email: user.profile?.email ?? null,
        isBot: Boolean(user.is_bot || user.is_app_user) || user.id === "USLACKBOT",
        isGuest: Boolean(user.is_restricted || user.is_ultra_restricted),
        deleted: Boolean(user.deleted),
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  peopleCache = { at: Date.now(), people };
  return people;
}

async function membersModal(route: Route): Promise<View> {
  syncMembers(await assignableMembers(route.jira_project_key!));
  const people = await slackPeople();
  const members = listMembers();
  const suggestions = suggestLinks(members, [...people.values()]);
  const shown = members.slice(0, 95);

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Match each Jira member of *${route.jira_project_key}* to their Slack account. Each Slack member can be linked once.\n` +
          `_To unlink someone, run \`/relay jira unlink @them\`._`,
      },
    },
  ];

  for (const member of shown) {
    const suggestion = member.slack_user ? undefined : suggestions.get(member.jira_account_id);
    const initial = member.slack_user ?? suggestion?.slackUser;
    const hint = [
      member.email ?? "Email hidden in Jira",
      initial && people.get(initial)?.isGuest ? "Guest in Slack" : null,
      suggestion ? `Suggested by ${suggestion.via}, check before saving` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    blocks.push({
      type: "input",
      block_id: `member_${member.jira_account_id}`,
      optional: true,
      label: plain(truncate(member.display_name, 200)),
      hint: plain(hint),
      element: {
        type: "users_select",
        action_id: "value",
        placeholder: plain("Not linked"),
        ...(initial ? { initial_user: initial } : {}),
      },
    });
  }

  if (members.length > shown.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Showing ${shown.length} of ${members.length} Jira members.` }],
    });
  }

  return {
    type: "modal",
    callback_id: LINK_MEMBERS,
    title: plain("Jira members"),
    submit: plain("Save links"),
    close: plain("Cancel"),
    blocks,
  };
}

function routeFromAction(body: unknown): Route | undefined {
  const value = (body as { actions?: Array<{ value?: string }> }).actions?.[0]?.value;
  return listRoutes().find((route) => String(route.id) === value && route.jira_board_id);
}

export function registerJiraAdmin(): void {
  app.action("relay_open_jira_board", async ({ ack, body, respond }) => {
    await ack();
    const { user, channel, triggerId } = actionContext(body);
    if (await denyIfNotAdmin(user, channel, respond)) return;
    if (triggerId) await openWhileLoading(triggerId, "Connect Jira board", boardModal);
  });

  const openForRoute =
    (title: string, build: (route: Route) => Promise<View>) =>
    async ({ ack, body, respond }: { ack: () => Promise<void>; body: unknown; respond: NonNullable<Parameters<typeof denyIfNotAdmin>[2]> }) => {
      await ack();
      const { user, channel, triggerId } = actionContext(body);
      if (await denyIfNotAdmin(user, channel, respond)) return;
      const route = routeFromAction(body);
      if (!route) {
        await respond({
          response_type: "ephemeral",
          replace_original: false,
          text: `${ICON.warning} Connect a Jira board to that pairing first.`,
        });
        return;
      }
      if (triggerId) await openWhileLoading(triggerId, title, () => build(route));
    };

  app.action("relay_open_jira_columns", openForRoute("Board columns", columnsModal));
  app.action("relay_open_jira_members", openForRoute("Jira members", membersModal));

  app.view(CONNECT_BOARD, async ({ ack, body, view }) => {
    if (await denyIfNotAdmin(body.user.id, undefined)) {
      await ack({ response_action: "errors", errors: { board: "You're not allowed to change Relay's configuration." } });
      return;
    }

    const values = view.state.values;
    const routeId = Number(values.route?.value?.selected_option?.value);
    const sprintChannel = values.sprint?.value?.selected_conversation ?? "";
    const [boardId, projectKey, boardName, boardType] = JSON.parse(
      values.board?.value?.selected_option?.value ?? "[0,\"\",\"\",\"\"]",
    ) as BoardChoice;

    if (!projectKey) {
      await ack({ response_action: "errors", errors: { board: "That board isn't tied to one project, which sprint sync needs." } });
      return;
    }
    if (boardType === "kanban") {
      await ack({ response_action: "errors", errors: { board: "That's a kanban board. Sprint sync needs a board with sprints." } });
      return;
    }

    const problem = await postingProblem(sprintChannel);
    if (problem) {
      await ack({ response_action: "errors", errors: { sprint: problem } });
      return;
    }

    const result = setJiraBoard(routeId, { boardId, boardName, projectKey, sprintChannel });
    if (!result.ok) {
      await ack({ response_action: "errors", errors: { sprint: result.error } });
      return;
    }
    await ack();

    // Columns and members are read now, so the next two buttons open already
    // filled in rather than starting from nothing.
    let note: string;
    try {
      const guessed = seedBuckets(boardId, await boardColumns(boardId));
      const found = syncMembers(await assignableMembers(projectKey));
      note =
        ` Mapped ${guessed} status${guessed === 1 ? "" : "es"} from the column names and found ${found.total} Jira members.` +
        ` Next: *Board columns* to check the mapping, then *Jira members* to link people.`;
    } catch (error) {
      note = ` But Relay couldn't read the board yet: ${describeJiraError(error)}`;
    }

    await announce(
      `${ICON.done} <@${body.user.id}> connected Jira board *${boardName}* (${projectKey}) to ` +
        `*${await channelName(result.route.client_channel)}*, with sprint threads in *${await channelName(sprintChannel)}*.${note}`,
      body.user.id,
    );
    void syncJiraNow();
  });

  app.view(MAP_COLUMNS, async ({ ack, body, view }) => {
    if (await denyIfNotAdmin(body.user.id, undefined)) {
      await ack({ response_action: "errors", errors: { column_0: "You're not allowed to change Relay's configuration." } });
      return;
    }

    const { boardId, columns } = JSON.parse(view.private_metadata) as { boardId: number; columns: BoardColumn[] };
    const choices = columns.map((column, index) => {
      const value = view.state.values[`column_${index}`]?.value?.selected_option?.value ?? "";
      return { column, bucket: isBucket(value) ? value : guessBucket(column.name) };
    });

    saveBuckets(boardId, choices, body.user.id);
    await ack();

    await announce(
      `${ICON.note} <@${body.user.id}> updated the Jira column mapping: ` +
        choices.map(({ column, bucket }) => `${column.name} → ${BUCKET_LABEL[bucket]}`).join(", ") +
        ".",
      body.user.id,
    );
    void syncJiraNow();
  });

  app.view(LINK_MEMBERS, async ({ ack, body, view }) => {
    const choices: LinkChoice[] = Object.entries(view.state.values)
      .filter(([blockId]) => blockId.startsWith("member_"))
      .map(([blockId, block]) => ({
        accountId: blockId.slice("member_".length),
        slackUser: block.value?.selected_user ?? null,
      }));

    if (await denyIfNotAdmin(body.user.id, undefined)) {
      const first = choices[0]?.accountId;
      await ack(
        first
          ? { response_action: "errors", errors: { [`member_${first}`]: "You're not allowed to change Relay's configuration." } }
          : undefined,
      );
      return;
    }

    const problems = linkProblems(choices, peopleCache?.people ?? new Map());
    if (Object.keys(problems).length > 0) {
      await ack({
        response_action: "errors",
        errors: Object.fromEntries(
          Object.entries(problems).map(([accountId, message]) => [`member_${accountId}`, message]),
        ),
      });
      return;
    }

    const linked = saveLinks(choices, body.user.id);
    await ack();
    await announce(
      `${ICON.note} <@${body.user.id}> linked ${linked} of ${choices.length} Jira members to Slack.`,
      body.user.id,
    );
    void syncJiraNow();
  });
}

/** `/relay jira`: the connection at a glance, plus `unlink`. Admins only. */
export async function jiraCommand(rest: string): Promise<string> {
  const [action = ""] = rest.split(/\s+/);

  if (action.toLowerCase() === "unlink") {
    const target = /<@([A-Z0-9]+)(?:\|[^>]*)?>/i.exec(rest)?.[1];
    if (!target) return "Usage: `/relay jira unlink @someone`";
    const member = unlinkSlackUser(target);
    return member
      ? `${ICON.done} Unlinked <@${target}> from ${member.display_name} in Jira.`
      : `<@${target}> isn't linked to a Jira member.`;
  }

  if (!jiraConfigured()) {
    return `${ICON.warning} Jira isn't configured. Set JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN on the server, then restart Relay.`;
  }

  if (action.toLowerCase() === "sync") {
    await syncJiraNow();
    return `${ICON.done} Synced with Jira. Stories, cards and boards are up to date.`;
  }

  const lines: string[] = [];
  try {
    const me = await myself();
    lines.push(`*Jira* · connected as ${me.displayName} on ${new URL(config.jira.url).host}`);
  } catch (error) {
    return `${ICON.warning} ${describeJiraError(error)}`;
  }

  const connected = listRoutes().filter((route) => route.jira_board_id);
  if (connected.length === 0) {
    lines.push("_No board connected. Use `/relay setup` → Connect Jira board._");
  }

  for (const route of connected) {
    lines.push(
      "",
      `*${boardLabel(route)}* (${route.jira_project_key}) · ${await channelName(route.client_channel)}` +
        (route.sprint_channel ? ` · sprint threads in ${await channelName(route.sprint_channel)}` : ""),
    );
    try {
      const sprint = await activeSprint(route.jira_board_id!);
      lines.push(
        sprint
          ? dot(`Active sprint: *${sprint.name}*`, dateRange(sprint.startDate, sprint.endDate))
          : "_No active sprint._",
      );
    } catch (error) {
      lines.push(`${ICON.warning} ${describeJiraError(error)}`);
    }

    const mapping = new Map(bucketsFor(route.jira_board_id!).map((row) => [row.column_name, row.bucket]));
    lines.push(
      mapping.size > 0
        ? `Columns: ${[...mapping].map(([column, bucket]) => `${column} → ${BUCKET_LABEL[bucket]}`).join(", ")}`
        : "_Columns not mapped yet._",
    );
  }

  const members = listMembers();
  const unlinked = members.filter((member) => !member.slack_user);
  lines.push(
    "",
    `Members: ${members.length - unlinked.length} of ${members.length} linked` +
      (unlinked.length > 0
        ? ` · not linked: ${unlinked.slice(0, 10).map((member) => member.display_name).join(", ")}${unlinked.length > 10 ? "…" : ""}`
        : ""),
  );

  return lines.join("\n");
}
