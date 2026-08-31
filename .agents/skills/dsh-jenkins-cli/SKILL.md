---
name: dsh-jenkins-cli
description: Use when the user asks you to trigger or kick off a Jenkins build, check a job's build status or history, find a job by keyword, tail or read a build's console log, triage a build failure, or stop a running build from inside the dsh-aio container, or when a `jcli` command fails because `~/.jenkins-cli.yaml` is missing, incomplete, or wrong and you need to ask the user for the missing details and write them into the config. The container ships the jenkins-zh `jcli` binary on PATH for exactly these Jenkins operations.
---

# Driving Jenkins from the dsh-aio container with jcli

The dsh-aio image bakes in [jenkins-zh/jenkins-cli](https://github.com/jenkins-zh/jenkins-cli) as `jcli` on PATH. This skill is guidance, not a script: it tells you how to reach a running Jenkins, act on a named job, and read back enough to report the result. Keep to jcli's documented `job` subcommands; when you are unsure of an exact flag, describe the intent and let the user confirm rather than inventing one.

## Confirm configuration before acting

`jcli` reads its server, user, and API token from `~/.jenkins-cli.yaml`. Nothing about a Jenkins server is baked into the image, so the first run in a fresh environment has no credentials.

1. Confirm the file exists and is complete before running any job command. Check for `~/.jenkins-cli.yaml` and that it names a Jenkins URL, a user, and an API token for that user.
2. If it is missing or incomplete, do not guess a server address or fabricate a token. Ask the user for their Jenkins URL, username, and API token, then help them populate `~/.jenkins-cli.yaml` with those values. The API token comes from the user's Jenkins account (user menu, then the security or API-token page); it is not a password to invent here.
3. This file lives under `/root`, which the standalone compose persists in a named volume, so a correct configuration survives image upgrades. You normally confirm it once and reuse it.

Never hardcode a Jenkins hostname, username, or token into commands, scripts, or notes. The only durable references you write are to the concept of the API token and to the `~/.jenkins-cli.yaml` path itself.

### The config file's shape

`~/.jenkins-cli.yaml` holds a list of servers plus a pointer to the one in use. Use these exact keys; do not invent field names.

```yaml
current: <server-name>          # which server jcli acts on right now
jenkins_servers:
  - name: <server-name>         # a label you pick for this server
    url: <jenkins-url>          # the Jenkins base URL the user gives you
    username: <user>            # the user's Jenkins username
    token: <api-token>          # the user's Jenkins API token (not a password)
    proxy: <optional>           # only if the user says a proxy is required
    insecureSkipVerify: false   # set true only for a trusted self-signed host
```

Prefer jcli's own config subcommands over hand-editing YAML; they validate as they write and are less error prone. Fall back to editing the file directly only when a subcommand cannot express what you need.

```sh
jcli config generate          # print a starter config template
jcli config add               # add a new server entry
jcli config list              # list the configured servers
jcli config select <name>     # set `current` to a configured server
jcli config edit              # edit the config
```

Whichever path you take, the real values (URL, username, token) always come from the user. You only transcribe what the user provides into the file; you never originate a hostname or token.

## Runtime error-correction loop

Configuration is rarely perfect on the first try. When you actually run a `jcli` command and it fails, treat the error text as a diagnosis: read it, decide what piece of information is missing or wrong, ask the user for exactly that piece, write it into `~/.jenkins-cli.yaml` (via a `jcli config` subcommand when possible, or by editing the field directly), then retry the original command and report the result. Never guess a value to make an error go away, and never invent a URL, username, or token. Only the user can supply real values; your job is to recognize what is needed, collect it, and record it.

The loop is always the same:

1. Run the command and read the error.
2. Classify the error using the cases below.
3. Ask the user for the specific values that case needs, explaining where a token comes from when a token is involved.
4. Write those values into the matching `~/.jenkins-cli.yaml` field (preferring `jcli config` subcommands).
5. Retry the original command and restate the outcome to the user.

### No server configured, or `current` not set

Symptom: an error like `current jenkins is not specified, kindly provide a valid value using "jcli config select"`, or a complaint that no server or configuration was found.

What it means: either `~/.jenkins-cli.yaml` has no server entry, or it has servers but `current` does not point at one.

Ask the user for: the Jenkins **URL**, their **username**, and their **API token**.

Fix: add a server and select it.

```sh
jcli config add        # supply name, url, username, token from the user
jcli config select <server-name>
```

If you edit the file directly instead, add an entry under `jenkins_servers` with `name`, `url`, `username`, and `token`, then set top-level `current` to that entry's `name`. Retry the original job command.

### Authentication failed (401 / 403)

Symptom: the command reaches Jenkins but is rejected with `401 Unauthorized`, `403 Forbidden`, or an "invalid credentials" style message.

What it means: the `token` (or sometimes the `username`) for the current server is wrong, revoked, or expired.

Ask the user for: a fresh **API token**, and confirm the **username** it belongs to. Remind them the token is generated from their Jenkins account (user menu, then the security or API-token page) and is not their login password. Do not fabricate a token under any circumstance.

Fix: update the current server's `token` field (and `username` if it was wrong) in `~/.jenkins-cli.yaml`, then retry. `jcli config edit` or a re-run of `jcli config add` for that server can rewrite these fields.

### Connection failed, host not found, or timeout

Symptom: `connection refused`, `no such host`, `could not resolve host`, `dial tcp ... i/o timeout`, or a hang that never reaches an HTTP status.

What it means: the `url` is wrong or unreachable, or the network requires a proxy to leave the container.

Ask the user to: confirm the Jenkins **URL** is exactly right (scheme, host, port, any path prefix), and whether reaching it requires a **proxy**.

Fix: correct the `url` field for the current server, or add a `proxy` field with the proxy the user gives you, in `~/.jenkins-cli.yaml`, then retry.

### TLS or certificate error (x509 / self-signed)

Symptom: `x509: certificate signed by unknown authority`, `certificate is not trusted`, `self-signed certificate`, or a similar TLS verification failure.

What it means: the Jenkins host serves an HTTPS certificate your trust store does not recognize, common for internal or self-signed servers.

Ask the user to: confirm they trust this specific host and want to skip certificate verification for it. This lowers a security check, so only proceed on the user's explicit say-so for an internal host they control.

Fix: with the user's agreement, set `insecureSkipVerify: true` on that server entry in `~/.jenkins-cli.yaml`, then retry. Leave it `false` (the default) for any host the user does not explicitly vouch for.

### Job not found or wrong name

Symptom: `no such job`, `404`, or a "job does not exist" style message after configuration is already valid.

What it means: this is not a configuration problem. The credentials work, but the job name is wrong.

Fix: do not touch `~/.jenkins-cli.yaml`. Search for the real name and confirm it with the user.

```sh
jcli job search <keyword>
```

Present the matches, let the user pick the intended job, then rerun the original command with the confirmed name.

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
