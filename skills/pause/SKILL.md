---
name: pause
description: The pause step that both flows share. It stops an issue's work until the maintainer acts.
disable-model-invocation: true
---

# Pause

A flow pauses an issue when it can't go on without the maintainer. The flow that sends you here names two things: the flight status it removes, and how the maintainer resumes the issue.

1. Post one comment with `save_comment`. This comment is the run's one comment on the issue.
2. In one `save_issue` call, set `removeLabels` to the flight status the flow names, such as `["building"]`, `addLabels` to `["needs-you"]`, and `assignee` to `"me"`. The Linear MCP server acts as the maintainer, so `"me"` is the maintainer.

Then go back to the flow, which says what to leave in place before you end.

## The pause comment

Open the comment with `**Paused.**` and what the maintainer has to do, in one or two sentences. End those sentences with how to resume, the way the flow names it. Then say what happened.

```markdown
**Paused.** Say which browser and version show the crash, then remove `needs-you`.

I couldn't reproduce the crash. I tried these, and each one passed:

1. ...
```

A later run finds the pause by that first line. It reads every comment posted after the latest `**Paused.**` comment as the maintainer's answer. So open no other comment with `**Paused.**`.
