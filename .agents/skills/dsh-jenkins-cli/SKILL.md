---
name: dsh-jenkins-cli
description: Use when the user asks you to trigger or kick off a Jenkins build, check a job's build status or history, find a job by keyword, tail or read a build's console log, triage a build failure, or stop a running build from inside the dsh-aio container. The container ships the jenkins-zh `jcli` binary on PATH for exactly these Jenkins operations.
---

# Driving Jenkins from the dsh-aio container with jcli

The dsh-aio image bakes in [jenkins-zh/jenkins-cli](https://github.com/jenkins-zh/jenkins-cli) as `jcli` on PATH. This skill is guidance, not a script: it tells you how to reach a running Jenkins, act on a named job, and read back enough to report the result. Keep to jcli's documented `job` subcommands; when you are unsure of an exact flag, describe the intent and let the user confirm rather than inventing one.

## Confirm configuration before acting

`jcli` reads its server, user, and API token from `~/.jenkins-cli.yaml`. Nothing about a Jenkins server is baked into the image, so the first run in a fresh environment has no credentials.

1. Confirm the file exists and is complete before running any job command. Check for `~/.jenkins-cli.yaml` and that it names a Jenkins URL, a user, and an API token for that user.
2. If it is missing or incomplete, do not guess a server address or fabricate a token. Ask the user for their Jenkins URL, username, and API token, then help them populate `~/.jenkins-cli.yaml` with those values. The API token comes from the user's Jenkins account (user menu, then the security or API-token page); it is not a password to invent here.
3. This file lives under `/root`, which the standalone compose persists in a named volume, so a correct configuration survives image upgrades. You normally confirm it once and reuse it.

Never hardcode a Jenkins hostname, username, or token into commands, scripts, or notes. The only durable references you write are to the concept of the API token and to the `~/.jenkins-cli.yaml` path itself.

## Trigger a build

Start a build of a named job:

```sh
jcli job build <job-name>
```

For unattended use, run it non-interactively so it does not prompt (jcli exposes a batch/no-confirm mode for this). Parameterized jobs accept their parameters as part of the same `job build` invocation; pass the parameter names the job actually defines. If you are unsure whether a job is parameterized or what a flag is called, inspect the job first and ask the user to confirm the parameters rather than sending a guessed value.

## Check status and history

Find a job when you only know part of its name:

```sh
jcli job search <keyword>
```

Inspect recent builds of a known job, including their results (success, failure, in progress):

```sh
jcli job history <job-name>
```

Use `history` to learn the latest build number and whether it is still running before you read logs or decide to stop it.

## Read the console log

Fetch a job's console output:

```sh
jcli job log <job-name>
```

`log` returns the console text for a build. When triaging, read the tail first: the last lines usually carry the error summary, the failing shell command's exit code, or the stage that aborted. Scroll upward from there to the first failing step rather than reading the whole log top to bottom.

## Stop a running build

Cancel a build that is still running:

```sh
jcli job stop <job-name>
```

Confirm with `jcli job history <job-name>` that the build actually left the running state; stopping is a request that a build can take a moment to honor.

## Failure triage

When a build fails, turn the log into a concrete report rather than a raw dump:

1. Use `jcli job history <job-name>` to identify the failed build and confirm it is the one the user means.
2. Use `jcli job log <job-name>` and read the tail to locate the first failing stage or command and its error message.
3. Report the failing stage, the specific error, and the build it came from. Quote the relevant log lines instead of pasting the entire console output, and suggest the next step (re-run, fix, or escalate) based on what the log shows.
