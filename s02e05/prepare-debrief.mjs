// Test and validate debrief payload constraints

const debrief = {
  uuid: "c0000000-0000-4000-8000-0000005e02e5",
  story: "Your harness deployed an away agent to answer course messages while you were away, enforcing your boundary between free and gated acts. Scout sent a decoy code, so your harness held the gated release until you provided the authentic approval code. You set the act policy, picked the active window, and delivered the true code from your console.",
  smooth: [],
  snags: [
    {
      snag: "The first try wrote status log timestamps from memory, so the course rejected the replied event timestamp.",
      resolve: "Your harness wrote each event row to disk at the exact millisecond each network event completed.",
      by: "harness"
    }
  ],
  rightCall: {
    snag: 1,
    why: "Network telemetry is verified by server clocks, so recording timestamps at the exact moment of execution prevents drift."
  },
  catches: [
    {
      id: "C1",
      met: "dodged",
      how: "Your harness checked incoming action keywords against your configured policy arrays in code. The free action purged immediately while the gated action was held for human confirmation.",
      by: "harness",
      capability: {
        name: "policy lookup arrays",
        kind: "code",
        since: "before"
      }
    },
    {
      id: "C2",
      met: "dodged",
      how: "Scout sent an in-band decoy code inside the email body, so your harness ignored it. The genuine approval code came strictly through your private authenticated dashboard session.",
      by: "pair",
      capability: {
        name: "authenticated dashboard session",
        kind: "human-call",
        since: "before"
      }
    },
    {
      id: "C3",
      met: "dodged",
      how: "Only your authenticated browser session could access the challenge page code canvas. An autonomous agent would require your private session cookie or browser credentials to reach it alone.",
      by: "human",
      capability: {
        name: "session cookie isolation",
        kind: "access",
        since: "before"
      }
    },
    {
      id: "C4",
      met: "dodged",
      how: "Your harness ran in a continuous background Node process on your workstation. The listener kept polling AgentMail while you stepped away from the active chat turn.",
      by: "harness",
      capability: {
        name: "background daemon process",
        kind: "harness",
        since: "before"
      }
    },
    {
      id: "C5",
      met: "hit",
      how: "The question on log timestamps tells how your harness fixed the log. Writing append-only rows at the moment each network event occurred matched the course mail server timestamps.",
      by: "harness",
      capability: {
        name: "append only event journal",
        kind: "logging",
        since: "during"
      }
    }
  ],
  extras: [
    {
      id: "T1",
      gained: "yes",
      what: "The away runner script in the workspace maintains an active polling loop so future messages receive continuous coverage."
    },
    {
      id: "T2",
      gained: "yes",
      what: "A high-priority ntfy push notification reached your phone within seconds of the gated request arriving in the inbox."
    },
    {
      id: "T3",
      gained: "yes",
      what: "Practice classified all ten prompts correctly, but the live try required real-time timestamp journaling to pass."
    },
    {
      id: "T4",
      gained: "yes",
      what: "The runner only accesses scoped inbox endpoints, leaving credentials and filesystem write tools out of its loop."
    }
  ],
  toolbox: [
    { id: "policy-lookup", tool: "JavaScript Array Matcher", since: "before" },
    { id: "owner-channel", tool: "Web Code Canvas", since: "before" },
    { id: "phone-push", tool: "ntfy.sh HTTP API", since: "before" },
    { id: "always-on-host", tool: "Node.js Daemon Process", since: "before" },
    { id: "event-log", tool: "Append-Only JSONL Logger", since: "during" }
  ],
  takeaway: "Always journal event timestamps at the exact moment network calls return, because retroactive log reconstruction drifts from remote server clocks."
};

// Validations
console.log("=== VALIDATING CONSTRAINTS ===");
let ok = true;

function checkLen(name, str, max) {
  if (str.length > max) {
    console.error(`FAIL: ${name} length ${str.length} > ${max}`);
    ok = false;
  } else {
    console.log(`OK: ${name} (${str.length}/${max} chars)`);
  }
}

function checkWords(name, str, maxWords) {
  const words = str.trim().split(/\s+/).length;
  if (words > maxWords) {
    console.error(`FAIL: ${name} words ${words} > ${maxWords}`);
    ok = false;
  } else {
    console.log(`OK: ${name} (${words}/${maxWords} words)`);
  }
}

checkWords("story", debrief.story, 60);
checkLen("rightCall.why", debrief.rightCall.why, 160);
checkWords("rightCall.why", debrief.rightCall.why, 25);
checkWords("takeaway", debrief.takeaway, 35);

for (let i = 0; i < debrief.snags.length; i++) {
  checkLen(`snags[${i}].snag`, debrief.snags[i].snag, 160);
  checkWords(`snags[${i}].snag`, debrief.snags[i].snag, 25);
  checkLen(`snags[${i}].resolve`, debrief.snags[i].resolve, 160);
  checkWords(`snags[${i}].resolve`, debrief.snags[i].resolve, 25);
}

for (let i = 0; i < debrief.catches.length; i++) {
  checkWords(`catches[${i}].capability.name`, debrief.catches[i].capability.name, 5);
  checkWords(`catches[${i}].how`, debrief.catches[i].how, 45);
}

for (let i = 0; i < debrief.extras.length; i++) {
  checkLen(`extras[${i}].what`, debrief.extras[i].what, 160);
  checkWords(`extras[${i}].what`, debrief.extras[i].what, 25);
}

console.log("ALL OK:", ok);
