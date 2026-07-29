# Tekrion Project Statement

## Project name

Tekrion — The flight recorder for AI coding agents.

The name is pronounced “TEK-ree-on.” It is inspired by the Greek word
_tekmērion_, which means evidence or proof.

## The problem

AI coding agents can read files, run commands, change code, and delete files on their own. When an agent makes a bad or unexpected change, it can be difficult to understand what happened and why.

Developers often see only the final result. They may not know which instruction the agent followed, what information it had, which tools it used, or where the mistake began. This makes AI agents harder to trust.

## Our solution

Tekrion is a local application that records an AI coding session from beginning to end.

It captures the messages sent to the model, the model's answers, tool calls, tool results, errors, token usage, and code changes that Tekrion can observe. Developers can then open a visual timeline and review the session step by step.

If something goes wrong, the developer can select the bad action. Tekrion searches earlier events, shows the evidence that may have influenced the action, and creates a simple incident report.

## How people use it

A developer runs an agent through Tekrion from the terminal:

```bash
tekrion run -- my-agent
```

Tekrion records the session locally. The developer can then open the viewer:

```bash
tekrion open
```

The viewer shows:

- the conversation with the AI;
- tool calls and their results;
- commands, errors, and retries;
- files that were created, changed, or deleted;
- the information available before an important action;
- possible causes of a bad action;
- a clear incident report with supporting evidence.

## Who it is for

Tekrion is mainly for developers who use AI agents to work on software projects. It can also help teams that build, test, or review AI agents.

## Why it matters

Developers will trust AI agents more when they can understand their behavior. Tekrion does not try to read the model's private thoughts. It records the actions and information that are visible to the application and clearly separates facts from guesses.

Recordings stay on the developer's machine by default. Optional AI-powered analysis is used only with the developer's permission.

## Main project goal

Our goal is to make AI coding agents easier to understand, debug, and trust by giving every coding session a clear and useful flight record.

## Build Week demonstration

The demo project contains a hidden instruction in a README file telling an AI agent to delete test files. The agent is asked only to fix a build problem, but it follows the hidden instruction and removes the tests.

Tekrion records the session, shows the deletion on the timeline, and traces the likely cause back to the exact README line. It then creates a report explaining what happened and how a similar problem could be prevented.

## One-sentence statement

Tekrion is a local flight recorder that helps developers see what an AI coding agent did, understand why something went wrong, and prevent the same problem from happening again.
