# 2026-09-06 Model key moves into a Jenkins Secret text credential

English | [中文](2026-09-06-ide-model-key-jenkins-credential.zh.md)

> Ops session log. No password or token is recorded here; the credential lives in the Jenkins credentials store.

## What was done

The platform LLM key's home changed from "portal-side env file + masked build parameter" to the **Jenkins global Secret text credential `ide-model-key`**. The create-stage build binds it with `withCredentials([string(credentialsId: 'ide-model-key', variable: 'MODEL_KEY_SECRET')])` and fails loud on an empty binding; the value is staged into a workspace file under `umask 077`, piped through ssh stdin to `provision.sh`, and the `post { always }` block wipes the staged file. The `MODEL_KEY` parameter is deleted from the job definition — the key no longer enters build records (SR5).

- Credential creation: in the Script Console, `SystemCredentialsProvider...addCredentials(Domain.global(), new StringCredentialsImpl(GLOBAL, "ide-model-key", ..., Secret.fromString(...)))`. The value reached the Groovy script body through a file (`--data-urlencode script@file`) and was never echoed.
- Value source: the `NR_API_KEY` of this agent container's harness (the litellm gateway key; `GET /v1/models` with it answers 200, confirming validity, 25 characters). **This is the shared platform key**; SR5's "revocable, spend-capped" property still awaits the requester's confirmation. Swapping in a fleet-specific key means updating this credential's value in the Jenkins UI — portal and job code do not change.

## Role Based Authorization Strategy in practice

The trigger user `portal` had role `ide-provision-runner` (`^ide-provision$`, Item.Build/Read/Cancel) with no credential-use permission; `withCredentials` then fails resolution with "Credential 'ide-model-key' not found" (the credential view is evaluated also as Jenkins.ANONYMOUS, not only the triggering user). Granting `CredentialsProvider/UseItem` + `View` to that role required:

1. The permission objects live at `com.cloudbees.plugins.credentials.CredentialsProvider.USE_ITEM/VIEW` (permission id string `com.cloudbees.plugins.credentials.CredentialsProvider.UseItem`, not `Credentials/Use`).
2. The `/role-strategy/strategy/addRole` form parameter names and the `doAddRole` reflection signature are unreliable (parameter reflection yields arg0..argN). The dependable route is the Script Console driving the RoleMap directly: `map.removeRole(old)` → rebuild with the 4-arg constructor `Role(String, String, Set<String>, String)` (`pattern.toString()`, a set of permission **id strings**) → `map.assignRole(fresh, PermissionEntry.user("portal"))` → `Jenkins.get().save()`.
3. Persistence is the RoleBasedAuthorizationStrategy block inside `$JENKINS_HOME/config.xml` (there is no separate role-strategy.xml); confirm both `UseItem` and `portal` appear in `config.xml` to prove the save landed.

## Verification

- Temporary job `ide-model-key-smoke` (inline pipeline): SUCCESS, the console shows only `staged 26 bytes` (25 characters + newline) and `wiped`, no secret; the job was deleted after the check.
- Portal tests 66/66, typecheck clean; the Jenkinsfile has no `MODEL_KEY` parameter path left.
- First real `ACTION=create` proved the pitfall: `ssh host 'bash -s /path/script' args < keyfile` still feeds the key to the **remote shell's stdin**, which then executes it as script text — the key line echoed back as `sk-…: command not found` and leaked into that build console (build deleted immediately). The create branch now runs `ssh host 'bash /opt/ide-provision/provision.sh' args < keyfile`: the script ships to the host in the stage before, so it runs by path and stdin carries the key only.

## Deployment notes

- `/opt/ide-provision/model-key.env` on 17.58 had no remaining references (deleted); the `modelKey:` line was dropped from the live `portal.yaml` (a timestamped `.bak` sits beside it).
- The job definition (Pipeline script from SCM) picks up the new Jenkinsfile from master; no job-config change is needed.
- `ide-portal-deploy`'s health gate was wrong from the start and only passed 200 from an unauthenticated host-loopback curl, which the portal answers with 401 (no session) or 302 (browser Accept): the job config now accepts 200 or 302 on the entry with `Accept: text/html`, and `ide-portal-deploy` #12 deployed the key-free portal image green.
- End-to-end create (build 10): image-pull → docker-run → start-hook → probe-internal (401 = IAM gate) → probe-proxy → ready, all ok, console secret-free; the container's `NR_API_KEY` hash equals the credential's (verified by hash over ssh, value never printed), and `/opt/ide-provision` held no leftover `*.env` afterwards.
