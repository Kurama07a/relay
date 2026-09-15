import type { KnownBlock, PlainTextOption, View } from "@slack/types";
import { mention } from "./names.js";
import { BUCKET_STYLE, dot, ICON } from "./design.js";
import { config } from "../config.js";
import { getTask, type Task } from "../store.js";
import { effortFor, formatExact, openSessionFor, sessionSeconds, sessionsFor } from "../sessions.js";
import { formatSlab, needsSplitting } from "../slabs.js";
import { loggedSeconds, logsFor } from "../worklogs.js";
import { memberForSlackUser, slackUserFor } from "../jira/members.js";
import { subtasksFor } from "../jira/stories.js";
import type { Route } from "../routes.js";
import {
  DESK,
  bucketOf,
  carriedNote,
  clip,
  currentSprint,
  deskStories,
  ownerLabel,
  peopleOptions,
  plain,
  sections,
  sprintLine,
  subtaskIcon,
  sum,
} from "./desk.js";

/**
 * The Team desk's two time panels, kept apart on purpose: **View time** only
 * reads, **Log time** only writes. Both start with the same two dropdowns — a
 * person, then that person's stories — so a long sprint narrows down to what
 * someone is actually looking for.
 *
 * The panel's state (which person, which story) travels in the modal's
 * private metadata, and every pick re-renders it in place.
 */

export type TimeMode = "view" | "log";

export interface TimeState {
  mode: TimeMode;
  routeId: number;
  /** A Jira account id, `unassigned`, or null for everyone. */
  person: string | null;
  taskId: number | null;
  /** Changes after each successful log, so Slack clears the form. */
  nonce: string;
}

export const EVERYONE = "everyone";

export const freshNonce = () => Date.now().toString(36);

/** Stories a person owns, or holds a subtask on. */
export function storiesFor(route: Route, person: string | null): Task[] {
  const stories = deskStories(route);
  if (!person) return stories;
  if (person === "unassigned") return stories.filter((story) => !story.jira_assignee);
  return stories.filter(
    (story) =>
      story.jira_assignee === person || subtasksFor(story.id).some((subtask) => subtask.jira_assignee === person),
  );
}

/**
 * Where a panel opens. Log time starts on your own stories when you have any;
 * a story opened directly shows everyone, so it's always in the list.
 */
export function initialTimeState(route: Route, mode: TimeMode, viewer: string, taskId: number | null = null): TimeState {
  const mine = memberForSlackUser(viewer)?.jira_account_id ?? null;
  const person = mode === "log" && !taskId && mine && storiesFor(route, mine).length > 0 ? mine : null;
  return { mode, routeId: route.id, person, taskId, nonce: freshNonce() };
}

async function pickers(route: Route, state: TimeState): Promise<KnownBlock> {
  const people: PlainTextOption[] = [
    { text: plain("Everyone"), value: EVERYONE },
    ...(await peopleOptions(deskStories(route))),
  ].slice(0, 100);
  const stories: PlainTextOption[] = storiesFor(route, state.person)
    .slice(0, 100)
    .map((story) => ({ text: plain(clip(`${story.jira_key} · ${story.title}`, 75)), value: String(story.id) }));

  const personInitial = people.find((option) => option.value === (state.person ?? EVERYONE));
  const storyInitial = stories.find((option) => option.value === String(state.taskId));

  return {
    type: "actions",
    // A new block id when the person changes, so Slack drops the old story pick.
    block_id: `time_pickers_${state.person ?? EVERYONE}`,
    elements: [
      {
        type: "static_select",
        action_id: DESK.pickPerson,
        placeholder: plain("Person"),
        options: people,
        ...(personInitial ? { initial_option: personInitial } : {}),
      },
      ...(stories.length > 0
        ? [
            {
              type: "static_select" as const,
              action_id: DESK.pickStory,
              placeholder: plain("Pick a story…"),
              options: stories,
              ...(storyInitial ? { initial_option: storyInitial } : {}),
            },
          ]
        : []),
    ],
  };
}

function storyHeader(task: Task, owner: string): KnownBlock[] {
  const style = BUCKET_STYLE[bucketOf(task.bucket)];
  const effort = effortFor(task.id);
  const logged = loggedSeconds(task.id);
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*${task.jira_key}* ${task.title}` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: dot(
            `${style.icon} ${style.label}`,
            owner,
            `exact *${formatExact(effort.totalSeconds)}*`,
            `logged *${formatSlab(logged)}*`,
            carriedNote(task),
          ),
        },
      ],
    },
  ];
}

/** The sprint's time, or one person's slice of it. */
async function sheetBlocks(route: Route, person: string | null): Promise<KnownBlock[]> {
  const slackUser = person && person !== "unassigned" ? slackUserFor(person) : null;
  const lines: string[] = [];
  let exactTotal = 0;
  let loggedTotal = 0;
  let theirsTotal = 0;

  for (const story of storiesFor(route, person)) {
    const exact = effortFor(story.id).totalSeconds;
    const logged = loggedSeconds(story.id);
    const theirs = slackUser
      ? sum(sessionsFor(story.id).filter((session) => session.engineer === slackUser).map(sessionSeconds))
      : 0;
    exactTotal += exact;
    loggedTotal += logged;
    theirsTotal += theirs;

    lines.push(
      dot(
        `${story.status === "done" ? ICON.done : BUCKET_STYLE[bucketOf(story.bucket)].icon} *${story.jira_key}* ${story.title}`,
        await ownerLabel(story, "team"),
        theirs > 0 ? `their time ${formatExact(theirs)}` : null,
        exact > 0 ? `exact ${formatExact(exact)}` : null,
        logged > 0 ? `logged ${formatSlab(logged)}` : null,
      ),
    );
  }

  return [
    { type: "divider" },
    ...sections(lines.length > 0 ? lines : ["_No stories here._"], 40),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: dot(
            slackUser ? `Their time *${formatExact(theirsTotal)}*` : null,
            person && person !== "unassigned" && !slackUser ? "_not linked to Slack, so their own time can't be picked out_" : null,
            `Exact *${formatExact(exactTotal)}*`,
            `logged *${formatSlab(loggedTotal)}*`,
          ),
        },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: "Pick a story for its breakdown by subtask and person." }] },
  ];
}

/** One story's time: each subtask by person, the story's own time, and recent sessions. */
async function storyTimeBlocks(task: Task): Promise<KnownBlock[]> {
  const blocks = storyHeader(task, await ownerLabel(task, "team"));
  const sessions = sessionsFor(task.id);
  const logs = logsFor(task.id);
  const subtasks = subtasksFor(task.id);

  const units = [
    ...subtasks.map((subtask) => ({ label: `${subtaskIcon(subtask)} *${subtask.jira_key}* ${subtask.title}`, subtaskId: subtask.id as number | null })),
    { label: "▫️ *The story itself*", subtaskId: null },
  ];

  const lines: string[] = [];
  for (const unit of units) {
    const own = sessions.filter((session) => (session.subtask_id ?? null) === unit.subtaskId);
    if (own.length === 0 && unit.subtaskId === null) continue;

    const byEngineer = new Map<string, number>();
    for (const session of own) byEngineer.set(session.engineer, (byEngineer.get(session.engineer) ?? 0) + sessionSeconds(session));
    const people = [...byEngineer].map(([engineer, seconds]) => {
      const slab = logs.find((entry) => entry.engineer === engineer && (entry.subtask_id ?? null) === unit.subtaskId);
      return `${mention(engineer)} ${formatExact(seconds)}${slab ? ` → logged ${formatSlab(slab.slab_seconds)}` : ""}`;
    });
    const exact = sum(byEngineer.values());
    lines.push(
      `${unit.label}\n${people.length > 0 ? people.join(" · ") : "_no time yet_"}` +
        (needsSplitting(exact) ? ` · ${ICON.warning} over ${config.slabs.splitWarningHours}h` : ""),
    );
  }
  blocks.push(...sections(lines.length > 0 ? lines : ["_No time recorded on this story yet._"], 30));

  const recent = [...sessions].reverse().slice(0, 12);
  if (recent.length > 0) {
    const rows = recent.map((session) =>
      dot(
        session.started_at.slice(0, 10),
        mention(session.engineer),
        subtasks.find((subtask) => subtask.id === session.subtask_id)?.jira_key ?? "story",
        formatExact(sessionSeconds(session)),
        session.ended_at ? session.source : `${ICON.active} running`,
        session.note ? `“${clip(session.note, 60)}”` : null,
      ),
    );
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Recent sessions*\n${rows.join("\n")}` } });
  }

  return blocks;
}

async function viewTimeView(route: Route, state: TimeState): Promise<View> {
  const task = state.taskId ? getTask(state.taskId) : undefined;
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `${ICON.timer} *Time* · ${sprintLine(currentSprint(route))}` } },
    await pickers(route, state),
    ...(task ? await storyTimeBlocks(task) : await sheetBlocks(route, state.person)),
  ];

  return {
    type: "modal",
    callback_id: DESK.timePanel,
    private_metadata: JSON.stringify(state),
    title: plain("View time"),
    close: plain("Close"),
    blocks: blocks.slice(0, 100),
  };
}

async function logTimeView(route: Route, viewer: string, state: TimeState, notice?: string): Promise<View> {
  const task = state.taskId ? getTask(state.taskId) : undefined;
  const blocks: KnownBlock[] = [];
  if (notice) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: notice }] });
  blocks.push(
    { type: "section", text: { type: "mrkdwn", text: `✍️ *Log time* · ${sprintLine(currentSprint(route))}` } },
    await pickers(route, state),
  );

  const base = {
    type: "modal" as const,
    callback_id: DESK.timePanel,
    private_metadata: JSON.stringify(state),
    title: plain("Log time"),
    close: plain("Close"),
  };

  if (!task) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Pick a story to log time on — narrow it to a person first if the list is long." }] });
    return { ...base, blocks };
  }

  blocks.push(...storyHeader(task, await ownerLabel(task, "team")));
  if (task.archived_at || task.status === "done") {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "This story is closed, so its time is final." }] });
    return { ...base, blocks };
  }

  const open = subtasksFor(task.id).filter((subtask) => !subtask.done_at);
  const units: PlainTextOption[] = [
    ...open.map((subtask) => ({ text: plain(clip(`${subtask.jira_key} · ${subtask.title}`, 75)), value: String(subtask.id) })),
    { text: plain("The story itself"), value: "0" },
  ];
  const preferred = open.find((subtask) => state.person && subtask.jira_assignee === state.person) ?? (open.length === 1 ? open[0] : undefined);
  const initialUnit = units.find((option) => option.value === String(preferred?.id ?? 0));
  const n = state.nonce;

  blocks.push(
    {
      type: "input",
      block_id: `unit_${n}`,
      label: plain("On"),
      element: { type: "static_select", action_id: "value", options: units, ...(initialUnit ? { initial_option: initialUnit } : {}) },
    },
    {
      type: "input",
      block_id: `duration_${n}`,
      label: plain("How long"),
      hint: plain("Like 1h 30m, 45m, 1.5h or 1:30."),
      element: { type: "plain_text_input", action_id: "value", placeholder: plain("1h 30m") },
    },
    {
      type: "input",
      block_id: `date_${n}`,
      label: plain("When"),
      element: { type: "datepicker", action_id: "value", initial_date: new Date().toISOString().slice(0, 10) },
    },
    {
      type: "input",
      block_id: `note_${n}`,
      optional: true,
      label: plain("What you did"),
      element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 500 },
    },
  );

  const running = openSessionFor(viewer);
  const mine = running?.task_id === task.id ? running : undefined;
  blocks.push(
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: mine
            ? `${ICON.active} Your clock is running on this story · ${formatExact(sessionSeconds(mine))}`
            : "Or run the clock while you work — it uses what's picked in *On*.",
        },
      ],
    },
    {
      type: "actions",
      block_id: `clock_${n}`,
      elements: [
        mine
          ? { type: "button", text: plain("⏸ Pause clock"), action_id: DESK.pause, value: String(task.id) }
          : { type: "button", text: plain("▶ Start clock"), action_id: DESK.start, value: String(task.id) },
        ...(open.length > 0
          ? [
              {
                type: "button" as const,
                text: plain("✓ Close subtask"),
                action_id: DESK.closeSubtask,
                value: String(task.id),
                confirm: {
                  title: plain("Close this subtask?"),
                  text: plain("Stops the clock on the subtask picked in On, and logs its time as a slab."),
                  confirm: plain("Close"),
                  deny: plain("Cancel"),
                },
              },
            ]
          : []),
        {
          type: "button",
          text: plain("✅ Done story"),
          action_id: DESK.done,
          value: String(task.id),
          confirm: {
            title: plain("Close the story?"),
            text: plain("Closes any open subtasks and logs the time. The client sees the total."),
            confirm: plain("Done"),
            deny: plain("Cancel"),
          },
        },
      ],
    },
  );

  return { ...base, submit: plain("Log time"), blocks };
}

/** Renders whichever of the two panels a state describes. */
export function timeView(route: Route, viewer: string, state: TimeState, notice?: string): Promise<View> {
  return state.mode === "view" ? viewTimeView(route, state) : logTimeView(route, viewer, state, notice);
}
