const menuButton = document.querySelector("[data-menu-button]");
const menu = document.querySelector("[data-menu]");

if (menuButton && menu) {
  menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isOpen));
    menu.dataset.open = String(!isOpen);
  });

  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      menuButton.setAttribute("aria-expanded", "false");
      menu.dataset.open = "false";
    }
  });
}

const demo = document.querySelector("[data-relay-demo]");

if (demo) {
  const states = [
    {
      state: "triage",
      clientStatus: "Seen by Relay",
      teamTitle: "Checkout throws a 500",
      teamMeta: "REL-7 · Bug · Jane in #acme",
      teamStatus: "Needs triage · unassigned",
      action: "Claim request",
      note: "A client message becomes a focused triage card.",
    },
    {
      state: "claimed",
      clientStatus: "Sam is picking this up",
      teamTitle: "Checkout throws a 500",
      teamMeta: "REL-7 · Bug · Jane in #acme",
      teamStatus: "Claimed · Sam",
      action: "Start work",
      note: "One reaction assigns the work and updates the client.",
    },
    {
      state: "working",
      clientStatus: "Sam has started",
      teamTitle: "Checkout throws a 500",
      teamMeta: "REL-7 · Bug · Jane in #acme",
      teamStatus: "In progress · Sam · active now",
      action: "Finish task",
      note: "The team works in its own thread; only deliberate updates cross over.",
    },
    {
      state: "done",
      clientStatus: "Done · fixed the timeout · about 2 hours",
      teamTitle: "Checkout throws a 500",
      teamMeta: "REL-7 · Bug · Jane in #acme",
      teamStatus: "Done · Sam · 2h 14m exact",
      action: "Replay flow",
      note: "The client gets a calm summary. The team keeps the exact ledger.",
    },
  ];

  let current = 0;
  const status = demo.querySelector("[data-client-status]");
  const title = demo.querySelector("[data-team-title]");
  const meta = demo.querySelector("[data-team-meta]");
  const teamStatus = demo.querySelector("[data-team-status]");
  const action = demo.querySelector("[data-demo-action]");
  const note = demo.querySelector("[data-demo-note]");

  const render = () => {
    const next = states[current];
    demo.dataset.step = next.state;
    status.textContent = next.clientStatus;
    title.textContent = next.teamTitle;
    meta.textContent = next.teamMeta;
    teamStatus.textContent = next.teamStatus;
    action.textContent = next.action;
    note.textContent = next.note;
  };

  action.addEventListener("click", () => {
    current = (current + 1) % states.length;
    render();
  });
}

const copyButtons = document.querySelectorAll("[data-copy]");

copyButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.querySelector(button.dataset.copy);
    if (!target) return;

    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = original;
      }, 1600);
    } catch {
      target.focus();
    }
  });
});

const revealItems = document.querySelectorAll("[data-reveal]");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if ("IntersectionObserver" in window && !reduceMotion) {
  document.documentElement.classList.add("has-reveal");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.dataset.visible = "true";
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  revealItems.forEach((item) => observer.observe(item));
}
