# Recipes

## Overview

This document provides a set of useful recipes you can use in xyOps.

## Custom Job Overrides

Custom Job Overrides allow administrators to reclassify and annotate completed jobs using global rules.  Each rule contains an expression that is evaluated against the completed job, plus a set of updates to apply when the expression matches.

This is useful when the same technical result can have a different operational meaning in your environment.  For example, you may want to treat an unavailable target as a critical error, consider a full queue to be only a warning, or flag successful jobs that returned partial data.

Rules are configured globally using the [job_custom_overrides](config.md#job_custom_overrides) property in `config.json` or `overrides.json`.  They apply to all completed jobs, including regular event jobs, workflow jobs, workflow sub-jobs, and ad hoc jobs.  This is an administrator-level feature, so job overrides should be reviewed with the same care as other protected server configuration.

### Rule Format

The configuration value is an array of rule objects.  Each rule supports the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `expression` | String | A required expression in [xyOps Expression Format](xyexp.md). |
| `updates` | Object | A required object containing top-level job properties to add or replace. |

Here is the basic structure:

```json
"job_custom_overrides": [
	{
		"expression": "YOUR_EXPRESSION_HERE",
		"updates": {
			"code": "warning",
			"push": {
				"tags": ["YOURTAGID"]
			}
		}
	}
]
```

Expressions use the completed [Job](data.md#job) as their context, so properties are referenced directly without a `job.` prefix.  For example, use `code`, `description`, `event`, `input.data`, and `data`, rather than `job.code` or `job.description`.

Job details that are separated internally while a job is running are available to expressions at completion time.  This includes input data and files, output data and files, timelines, workflow data, and server data.

### Evaluation and Completion Order

Rules are evaluated in the order they appear in the array.  Every matching rule is applied, and later rules see updates made by earlier rules.  This allows rules to build on one another, but it also means their order can matter.

Custom overrides run before retries, completion actions, statistics, system hooks, and final job storage.  As a result:

- Changing `code` changes which completion conditions fire, such as `success`, `warning`, `critical`, `abort`, `error`, or `user`.
- Changing a non-zero result to `0` can prevent a retry that would otherwise occur.
- Changing `abort` to another non-zero code can make the job eligible for an ordinary retry limit.
- Pushed tags are available to tag-based completion actions.
- The final overridden values are stored in job history and used for statistics.

If a rule is malformed or its expression cannot be evaluated, xyOps adds a warning to the job meta log and continues processing the remaining rules.

### Replacing Properties and Pushing Array Values

Properties inside `updates` are shallow top-level additions or replacements.  For example, this replaces the final result code and description:

```json
"updates": {
	"code": "warning",
	"description": "The expected capacity limit was reached."
}
```

Assigning an array property directly replaces the existing array.  To append values instead, use the special `push` object.  This is most commonly used for tags:

```json
"updates": {
	"push": {
		"tags": ["capacitywarning"]
	}
}
```

The `push` system can append to any existing array property on the job, including `tags`, `actions`, and `limits`.  A push is ignored when the target job property is not an array.

Tag values must be existing tag IDs.  Unknown tags are removed during job completion, so create the tags first and copy their IDs from the UI.  See [Tags](tags.md) for details.

### Protected Job Properties

Some internal properties can be inspected by expressions but cannot be changed by custom overrides.  These properties are protected because they identify the job, control its lifecycle, or are managed in separate job-detail storage:

```text
data, files, input, activity, timelines, output, workflowData, serverData,
id, state, completed, elapsed, event, category, plugin
```

Updates to these properties are ignored.  Other top-level properties may be added or replaced by an administrator.

### Distinguish Unavailable Targets from a Full Queue

xyOps normally reports both of these launch failures using the `abort` result code:

- No eligible target servers are available.
- No eligible servers are available and the configured queue is already full.

An administrator may consider the first case a critical targeting or infrastructure error, while the second case is expected backpressure that only needs a warning.  These rules classify them separately and add searchable tags:

```json
"job_custom_overrides": [
	{
		"expression": "(code == 'abort') && (description == 'No available servers matching targets.')",
		"updates": {
			"code": "critical",
			"push": {
				"tags": ["targetunavailable"]
			}
		}
	},
	{
		"expression": "(code == 'abort') && (description == 'No available servers matching targets, and the queue is full.')",
		"updates": {
			"code": "warning",
			"push": {
				"tags": ["queuefull"]
			}
		}
	}
]
```

Replace `targetunavailable` and `queuefull` with tag IDs defined in your installation.  Exact description comparisons are used here because the two messages share the same prefix.

### Treat a Known No-Op Result as Success

Some tools use a non-zero exit code for a valid no-op result, such as finding that no files or records need to be changed.  This example limits the override to one event and converts that known result into a success:

```json
"job_custom_overrides": [
	{
		"expression": "(event == 'YOUR_EVENT_ID') && (code == 3) && match(description, 'No changes required')",
		"updates": {
			"code": 0,
			"description": "No changes were required."
		}
	}
]
```

Replace `YOUR_EVENT_ID` with the actual event ID.  Because the final code becomes `0`, success actions fire and error actions do not.

### Promote Partial Output to a Warning

A plugin may exit successfully while reporting a partial result in its structured output data.  Output data is available to expressions through the top-level `data` property:

```json
"job_custom_overrides": [
	{
		"expression": "data && (data.status == 'partial')",
		"updates": {
			"code": "warning",
			"description": "The job completed with partial results.",
			"push": {
				"tags": ["partialresult"]
			}
		}
	}
]
```

This preserves the plugin's output data while changing how the final job is classified.

### Flag Slow Successful Jobs

The `elapsed` property contains the completed job duration in seconds.  This example keeps a slow job successful, updates its description, and pushes a tag for searching or tag-based actions:

```json
"job_custom_overrides": [
	{
		"expression": "(!code) && (elapsed >= 3600)",
		"updates": {
			"description": "The job completed successfully, but took one hour or longer.",
			"push": {
				"tags": ["slowjob"]
			}
		}
	}
]
```

### Build Rules in Stages

Because later rules see earlier updates, you can separate classification from annotation.  The first rule below converts one result to a warning.  The second rule then adds a tag to every warning, including warnings produced by the first rule:

```json
"job_custom_overrides": [
	{
		"expression": "(event == 'YOUR_EVENT_ID') && (code == 2)",
		"updates": {
			"code": "warning"
		}
	},
	{
		"expression": "code == 'warning'",
		"updates": {
			"push": {
				"tags": ["warningresult"]
			}
		}
	}
]
```

### Testing and Troubleshooting

Keep these tips in mind when introducing new rules:

- Start with exact event, plugin, category, or description matches, then broaden the expression after confirming the result.
- Test rules on a non-production event before applying them across the installation.
- Check the job meta log for malformed-rule or expression warnings.
- Remember that all matching rules apply.  Review later rules for expressions that may also match an updated result.
- Define tag IDs before pushing them, and verify the IDs rather than their display titles.
- Use the helpers documented in [xyOps Expression Format](xyexp.md), including `match`, `includes`, and `find`, for more advanced conditions.

## Continuous Jobs

A continuous job is defined as a job that automatically relaunches itself upon completion. This functionality can enhance the efficiency and reliability of job execution in various systems.  To implement a continuous job, follow these steps:

1. **Wire Up Completion Actions**: 
   - Set up actions that will trigger the same event upon job completion.
2. **Error Handling**:
   - If the job fails, implement a separate error handler. This handler can:
     - Notify the responsible parties about the failure.
     - Restart the job if necessary.

### Managing Job Failures

For jobs that experience repeated failures, it is essential to manage the process to prevent system disruption. Consider the following strategies:

- **Retry Limiter**: 
  - Establish a maximum limit for retries to avoid indefinite job execution.
- **Retry Delay**: 
  - Introduce a delay between retries to allow for recovery or resolution of the underlying issue.

### Summary

By following these guidelines, you can create a robust continuous job system that can efficiently manage execution, handle errors gracefully, and avoid negative impacts on system performance. 

## Nightly S3 Backup Workflow

Back up databases and files to Amazon S3 on a fixed schedule, with optional retention and notifications.

### How It Works

- Trigger: Add a `schedule` trigger for 01:00 in your timezone, and enable `catchup` so missed runs replay after outages.
- Workflow: Use a workflow so you can multiplex the job across multiple DB servers.
  - Multiplex Controller: Attach a job node to run on a group of servers (i.e. "Database" group).
    - Use the "stagger" option to spread jobs out, or use [Max Jobs Limit](limits.md#max-jobs-limit) and [Max Queue Limit](limits.md#max-queue-limit) to run them in series.
  - Job node 1: Shell Plugin to create backups on each target DB server. 
    - Examples: `pg_dump` or `mysqldump`, plus `tar` and `gzip` for directories.
	- Add files to output of job, e.g. `echo '{"xy":1, "code":0, "files":["*.tgz"]}'`;
  - Job node 2, wired via "continue" condition: Upload all input files to S3.
    - Target a server with outbound network access.
- Limits: Add a [Max Time Limit](limits.md#max-time-limit) and a [Max CPU Limit](limits.md#max-cpu-limit) to the backup job. Add a [Max Jobs Limit](limits.md#max-jobs-limit) to avoid overlapping runs.
- Notifications: Add a [Web Hook](actions.md#web-hook) or [Email](actions.md#email) action on `error` and `critical` with links to the job.

### Notes

- Use `params` and event `fields` for database credentials and include Secrets where appropriate.

## Advanced Data Exports

The [`admin_export_data`](api.md#admin_export_data) API provides shortcut options for most backups.  For more control, use its advanced `items` array.  This lets you filter database records with custom queries, limit the number of records exported, and raise the default 1 MB limit for individual files.

Create an [API Key](api.md#api-keys) with the [`bulk_export`](privileges.md#bulk_export) privilege before using this recipe.

### How It Works

Each object in the `items` array describes one export operation.  Items are processed in the order provided.

| Item Type | Properties | Description |
|-----------|------------|-------------|
| `list` | `key` (required) | Export a storage list and all its pages.  For example, use `global/events` for events or `global/stats` for stat history. |
| `index` | `index` (required), `query`, `max_rows` | Export matching database records, newest first.  `query` defaults to `*`, which matches all records. |
| `users` | `avatars` | Export individual user records.  Set `avatars` to `true` to include both avatar sizes. |
| `jobFiles` | `query`, `max_rows`, `max_size`, `logs`, `files` | Export files and/or external logs from matching jobs, newest first.  `query` defaults to `tags:_files`, and `max_size` defaults to 1 MB per file. |
| `ticketFiles` | `query`, `max_rows`, `max_size` | Export attachments from matching tickets, newest first.  `query` defaults to `*`, and `max_size` defaults to 1 MB per file. |
| `monitorData` | `query` | Export monitor timelines for matching servers.  `query` defaults to `*`. |
| `bucketData` | None | Export the data stored in every bucket. |
| `bucketFiles` | `max_size` | Export files stored in buckets.  `max_size` defaults to 1 MB per file. |
| `secretData` | None | Export the encrypted value stored for every secret. |

The `query` property uses the [Unbase query syntax](https://github.com/jhuckaby/pixl-server-storage/blob/master/docs/Indexer.md#simple-queries).  The `max_rows` property limits the number of matching records or jobs processed.  The `max_size` property is a per-file limit specified in bytes.  For example, `104857600` allows files up to approximately 100 MB.

Save your advanced request body in a file such as `export.json`, then run:

```sh
curl -X POST "https://xyops.mycompany.com/api/app/admin_export_data/v1" \
	-H "X-API-Key: YOUR_API_KEY_HERE" \
	-H "Content-Type: application/json" \
	--data @export.json \
	-O -J
```

The `-O -J` options save the archive using the filename supplied by xyOps.

### Export Records Using a Custom Query

This request exports up to 10,000 failed jobs in the `general` category:

```json
{
	"items": [
		{
			"type": "index",
			"index": "jobs",
			"query": "tags:_error category:general",
			"max_rows": 10000
		}
	]
}
```

The same pattern works with the `alerts`, `servers`, `snapshots`, `activity`, and `tickets` indexes.  Query fields depend on the selected index.

### Export Larger Job Files and Logs

File items export the stored file data, but they do not automatically export the associated database records.  Include both an `index` item and a file item when you need a self-contained set of job records and their files.

This request exports the newest 5,000 failed jobs, along with their external logs and job files up to approximately 100 MB each:

```json
{
	"items": [
		{
			"type": "index",
			"index": "jobs",
			"query": "tags:_error",
			"max_rows": 5000
		},
		{
			"type": "jobFiles",
			"query": "tags:_error",
			"max_rows": 5000,
			"max_size": 104857600,
			"logs": true,
			"files": true
		}
	]
}
```

Use the same query and row limit for both items so the record and file selections stay aligned.

### Export Larger Ticket and Bucket Files

This request combines the normal shortcut interface with advanced file items.  It exports all critical lists, all ticket records, ticket attachments up to approximately 100 MB each, and bucket files up to approximately 500 MB each:

```json
{
	"lists": "all",
	"indexes": ["tickets"],
	"items": [
		{
			"type": "ticketFiles",
			"query": "*",
			"max_size": 104857600
		},
		{
			"type": "bucketFiles",
			"max_size": 524288000
		}
	]
}
```

Shortcut selections are appended to the `items` array.  Do not also specify `"extras": ["ticket_files", "bucket_files"]` in this example, because that would export the same files a second time using the default 1 MB limit.

### Notes

- Raising `max_size` can substantially increase memory use, transfer time, and archive size because files are loaded and encoded as base64 during export.
- `jobFiles` only exports external job logs.  Logs already stored inline in the job record are included by the corresponding `index` export.
- `ticketFiles` only exports attachment data.  Export the matching `tickets` index records as well so the attachment metadata is preserved.
- `bucketFiles` includes each bucket's file manifest.  Export the `global/buckets` list and `bucketData` item as well when building a complete bucket backup.
- Secret values remain encrypted in the export.  Preserve the original xyOps configuration and `secret_key` so they can be decrypted after migration.
- API keys are stored as salted hashes and cannot be recovered as plaintext from an export.

## Video Transcoding Pipeline

Transcode incoming videos to MP4 H.264 and push the outputs to storage and a CDN. Supports parallel processing with progress feedback.

### How It Works

- Entry: Manual trigger for ad hoc batches or a custom trigger plugin that watches an S3 bucket for new file arrivals.
- Workflow graph:
  - Fetch: Optional fetch job on start to pull source files into the job input (wire manual run to different start node).
  - Split: Use a Split controller on `files` so each sub job gets exactly one input file.
  - Job: Shell Plugin that runs `ffmpeg` with a standard preset, writes output to the job temp dir, and prints periodic progress. 
    - For example, wrap ffmpeg and emit `{ "xy": 1, "progress": N }` updates while parsing ffmpeg stderr.
	- - Add files to output of job, e.g. `{"xy":1, "code":0, "files":["*.mp4"]}`;
  - Continue: After all items complete, continue to a packaging step that generates a manifest or index.
  - Store: On the transcoding node, attach a custom action to upload the MP4 outputs to S3 or other storage.
- Limits: Attach [Max CPU Limit](limits.md#max-cpu-limit), [Max Memory Limit](limits.md#max-memory-limit), [Max Time Limit](limits.md#max-time-limit), [Max Jobs Limit](limits.md#max-jobs-limit) and [Max Queue Limit](limits.md#max-queue-limit) to the transcode node to control resource usage and queue depth.
- Notifications: On `success`, fire a Web Hook to your CDN cache purge endpoint. On `error`, send email or post to a channel.

### Notes

- If you need per server fan out, target the ffmpeg at a server group instead of a single server, and select "Round Robin" algo.
- Tag successful jobs with `transcoded` and wire a `tag:transcoded` action to trigger downstream publishing.

## PostgreSQL Metrics

Collect PostgreSQL health metrics from the CLI and graph them, with alerts and automated remediation.

### How It Works

- Monitor Plugin: Write a simple Monitor Plugin that runs `psql` and emits one numeric metric per minute. Point the monitor expression at the plugin output.
- Examples of CLI queries that return a single number:

```sh
# Active connections on a specific database
psql -At -d mydb -c "select count(*) from pg_stat_activity where datname = 'mydb' and state = 'active'"

# Replication lag in seconds on a standby
psql -At -d postgres -c "select extract(epoch from now() - pg_last_xact_replay_timestamp())::int"

# Autovacuum backlog estimate (dead tuples)
psql -At -d mydb -c "select n_dead_tup from pg_stat_user_tables order by n_dead_tup desc limit 1"
```

- In the monitor configuration:
  - Expression: reference the plugin command output path such as `commands.pg_active_conns`.
  - Data Match: if your plugin returns a line of text, set a regex like `(\d+)` to extract the number.
  - Type: choose `integer` or `seconds` depending on the metric.
- Alerts: Create alerts that fire when thresholds are exceeded for a few minutes, for example:
  - Active connections above 90 percent of `max_connections` for 5 minutes.
  - Replication lag above 60 seconds for 3 minutes.
- Actions: On alert, run an event that captures pg diagnostics, or kick off `vacuumdb` during a maintenance window.

### Notes

- Store database credentials in Secrets and inject via environment or params; do not hardcode.

## Web Service Health Alert

Alert when a local web service stops responding on the same server as xySat. This recipe uses a [Monitor Plugin](plugins.md#monitor-plugins) to run a small `curl` check every minute, but it does **not** create a xyOps [Monitor](monitors.md). Monitors are for graphing numeric values over time. Here we only need a simple string status, so the alert can match the raw Plugin output directly.

### How It Works

- Monitor Plugin: Create a Monitor Plugin that runs on the server or server group hosting your web service.
	- **Plugin Title**: Web Service Health
	- **Plugin ID**: Automatically assigned when created
	- **Command**: `/bin/bash`
	- **Format**: `text`
	- **Script**:

```sh
URL="http://127.0.0.1:8080/health"

if curl --fail --silent --output /dev/null \
	--connect-timeout 5 \
	--max-time 5 \
	--retry 3 \
	--retry-delay 1 \
	--retry-all-errors \
	--retry-max-time 20 \
	"$URL"; then
	echo "UP"
else
	echo "DOWN"
fi
```

- Replace the `URL` value with your service's local health endpoint. This can be a loopback URL like `http://127.0.0.1:8080/health`, or any URL reachable from the xySat server.
	- The example uses `127.0.0.1` instead of `localhost` to avoid hostname lookup ambiguity, especially on systems where `localhost` may try IPv6 (`::1`) before IPv4.
- The `--fail` flag tells `curl` to treat HTTP error responses such as `404` or `500` as failures instead of successful downloads.
- The `--silent` and `--output /dev/null` flags keep the Plugin output clean, so xyOps receives only `UP` or `DOWN`.
- The `--connect-timeout 5` flag caps how long `curl` waits to establish the connection.
- The `--max-time 5` flag caps how long each request attempt may take, which prevents an unreachable service from tying up the xySat command for too long.
- The `--retry 3` flag gives the service a few extra chances within the same minute sample before reporting `DOWN`. This helps avoid firing on a single dropped packet or brief restart.
- The `--retry-delay 1` flag waits one second between retry attempts.
- The `--retry-all-errors` flag asks `curl` to retry more failure types, including connection and timeout errors.
- The `--retry-max-time 20` flag caps the total retry window, so the Plugin does not spend too much of the minute waiting.

The raw output from a Monitor Plugin is placed into [ServerMonitorData.commands](data.md#servermonitordata-commands), keyed by the Plugin ID. Replace `YOUR_PLUGIN_ID` below with the actual Plugin ID assigned by xyOps. The server data will look like this:

```json
"commands": {
	"YOUR_PLUGIN_ID": "UP"
}
```

When the service is unreachable, the value will be:

```json
"commands": {
	"YOUR_PLUGIN_ID": "DOWN"
}
```

### Alert Definition

Create a new [Alert](alerts.md) and point its expression at the Plugin output:

```js
!match(commands.YOUR_PLUGIN_ID, "UP")
```

The `match()` helper function is part of the [xyOps Expression Format](xyexp.md#custom-functions). This expression returns true when the raw command output does **not** contain `UP`, so the alert fires if the service is down, or if the Plugin fails to produce its expected healthy output.

Suggested alert settings:

- **Title**: Web Service Down
- **Expression**: `!match(commands.YOUR_PLUGIN_ID, "UP")`
- **Message**: `Web service health check failed.`
- **Samples**: `1`, so the alert can fire on the same minute sample after `curl` has exhausted its retries.
- **Server Groups**: Select the group that hosts the web service, or leave blank if it should apply everywhere.
- **Alert Actions**: Add email, channel, ticket, web hook, snapshot, or run-job actions as needed.

### Why Not Create a Monitor?

This recipe intentionally skips creating a xyOps [Monitor](monitors.md). Monitors store and graph numeric values such as CPU load, free memory, request counts, latency, or disk usage. This Plugin outputs a status string instead: `UP` or `DOWN`.

Because [alerts](alerts.md#alert-expressions) evaluate against the current server monitoring data, they can read `commands.YOUR_PLUGIN_ID` directly. That lets the alert fire from the Plugin's raw text output without forcing the value into a numeric graph.

### Notes

- Keep the Plugin output limited to `UP` or `DOWN`. Extra text can make the alert expression harder to reason about.
- Tune the timeout and retry values for your service. Shorter timeouts detect failures faster, while more retries help avoid false positives during brief restarts or network blips. If you set alert samples above `1`, remember that each sample adds another minute before the alert fires.
- If your service has a health endpoint, use that instead of the root URI path. A dedicated health endpoint can check database connections, cache availability, or other dependencies before returning success.
- If you monitor multiple services, create one Monitor Plugin per service, or output JSON from one Plugin and match each service path separately in different alerts.

## Sunrise and Sunset Trigger

Launch jobs at local sunrise and sunset with optional offsets. Useful for energy jobs, IoT device control, or time shifting heavy tasks to off peak windows.

### How It Works

- Trigger Plugin: Implement a scheduler plugin that calculates today's sunrise and sunset for a configured latitude and longitude. The plugin runs once per minute, compares the current time in a configured timezone, and indicates a launch when a window is hit.
  - Recommended module for Node.js: [SunCalc](https://www.npmjs.com/package/suncalc)
- Parameters: `lat`, `lon`, `timezone`, `sunrise_offset_sec`, `sunset_offset_sec`, and optional `launch` selector `sunrise` or `sunset` or `both`.
- Workflow: Wire the plugin trigger node into a workflow that branches on which event fired. For example:
  - At sunrise: run an HTTP Request Plugin that calls a home automation API to power down exterior lights and open blinds.
  - At sunset: run a batch window starter that increases queue sizes or begins off peak data processing.
- Actions: Add a Web Hook on `start` and `success` for observability.
- Limits: Add `max_concurrent` to protect against duplicates if the plugin window spans multiple minutes.

### Notes

- To avoid dependency on external APIs, embed sunrise calculations in the plugin. Any language is fine.
- Provide an optional test mode that forces a launch to validate the graph end to end.

## Server Offline Notifications

Notify your team when any server disconnects from the xyOps network. This uses a [System Hook](syshooks.md), which runs in the background when matching activity is logged.

### How It Works

Add a `server_remove` hook into the [hooks](config.md#hooks) section in your `config.json`. This activity fires when a server disconnects from the network. See [Activity.action](data.md#activity-action) for the full list of activity action IDs that can trigger System Hooks.

Simple web hook example:

```json
"hooks": {
	"server_remove": {
		"url": "https://alerts.mycompany.com/api/xyops-server-offline"
	}
}
```

Email example:

```json
"hooks": {
	"server_remove": {
		"email": "oncall-pager@mycompany.com"
	}
}
```

You can also use a configured xyOps web hook ID if you want custom headers, request body templates, or other delivery options:

```json
"hooks": {
	"server_remove": {
		"web_hook": "wmkd2yx4yw4ihh7lu"
	}
}
```

To notify when a server comes back online, or when a new server is added to the network, add a `server_add` hook as well:

```json
"hooks": {
	"server_remove": {
		"email": "oncall-pager@mycompany.com"
	},
	"server_add": {
		"email": "oncall-pager@mycompany.com"
	}
}
```

### Notes

- The `server_remove` activity fires whenever a server disconnects, including planned upgrades, service restarts, network maintenance, and other expected outages. It does not always mean the server crashed.
- The `server_add` activity fires whenever a server connects to the network. This means a previously offline server returned, or a brand new server was added.

## Daylight Savings Time

Local clock time can be surprisingly tricky for a job scheduler. In timezones that observe daylight saving time (DST), the clock changes seasonally, usually by one hour:

- **Fall back:** When returning to standard time, an entire hour is repeated. A clock reading such as 02:30 occurs twice, at two different instants.
- **Spring forward:** When entering daylight saving time, an entire hour is skipped. A clock reading such as 02:30 may not exist at all that day.

For example, under the current rules for `Europe/Berlin`, the clock moves from 03:00 back to 02:00 in autumn, and from 02:00 forward to 03:00 in spring. A daily Schedule trigger for 02:30 therefore matches twice on the fall-back day and never on the spring-forward day. The [IANA timezone database](https://data.iana.org/time-zones/tzdb/europe) records these regional rules.

This is a scheduler's nightmare when the requirement is "run once every day at this local time." The date and clock reading alone cannot always identify one instant. We will call the repeated or skipped window the **danger hour**. Its exact hours, transition dates, and even the size of the clock change depend on the timezone, so check the rules for your location.

Here are several ways to handle this, depending on what your job needs.

### Solution 1: Avoid the Danger Hour

The simplest option is to schedule time-sensitive daily jobs outside the affected window. For example, 04:30 avoids both transitions in `Europe/Berlin` under its current rules. When entering a local date and time for a Single Shot, avoiding the danger hour also avoids choosing a nonexistent or ambiguous clock reading.

An hourly job is a useful exception. If it needs to run every hour, a Schedule trigger with all hours allowed and a fixed minute, such as `15`, continues at hourly intervals across a one-hour DST change. The repeated hour gets two runs, and the skipped hour gets none, but the real elapsed time between runs remains one hour. This means 25 runs on the fall-back day and 23 on the spring-forward day, which is appropriate for a job that truly runs every hour. For a fixed elapsed interval regardless of the size of a timezone change, see [Solution 5](#solution-5-use-a-fixed-interval).

### Solution 2: Use a Fixed-Offset Timezone

Select one of the `Etc/GMT+` or `Etc/GMT-` timezones in the Schedule trigger's **Timezone** menu. These provide a local clock at a fixed offset from UTC, without seasonal DST changes. You can also select `Etc/UTC` if your schedule can be expressed directly in UTC.

Note that the signs in these names are reversed from what you might expect:

| Timezone | Fixed UTC offset |
|----------|------------------|
| `Etc/GMT-8` | UTC+08:00 |
| `Etc/GMT+8` | UTC-08:00 |
| `Etc/GMT-1` | UTC+01:00 |
| `Etc/UTC` | UTC+00:00 |

This naming convention comes from POSIX; see the [IANA fixed-offset definitions](https://data.iana.org/time-zones/tzdb/etcetera).

For example, scheduling 02:30 in `Etc/GMT-1` gives you a steady UTC+1 schedule. It runs at 02:30 in Berlin during standard time, and at 03:30 in Berlin during daylight saving time. There is no repeated or missing scheduled minute.

The tradeoff is that a fixed offset matches your region's clock for one part of the year and is typically one hour off during the other part. Choose this when a stable offset matters more than following the seasonal local clock. Set the timezone on the trigger itself; changing the server's process timezone does not change the DST rules of a trigger explicitly set to `Europe/Berlin`.

### Solution 3: Add a Backup Time and a Max Daily Limit

For a short daily job that should run once even when its preferred time is skipped, combine two candidate times with a [Max Daily Limit](limits.md#max-daily-limit).  This limit will silently skip extra job runs rather than raise errors.

For example, to run at 02:30 in Berlin with a backup at 03:30:

1. Add a **Schedule** trigger with hours `2` and `3` selected, minute `30`, and timezone `Europe/Berlin`.
2. Add a **Max Daily Limit** with Job Condition set to **Complete** and Max Daily Amount set to **1**.

You can also use two separate Schedule triggers. For other timezones, choose a backup time outside the skipped window; one hour later works for this Berlin example.

Provided the job finishes before the next candidate time, this handles all three cases:

| Day | Behavior |
|-----|----------|
| Normal | The 02:30 job completes, so the 03:30 backup is blocked. |
| Spring forward | There is no 02:30, so the 03:30 backup runs. |
| Fall back | The first 02:30 job completes, so the repeated 02:30 and the 03:30 backup are blocked. |

Keep these details in mind:

- **Complete counts completions, including failures.** It does not reserve a slot when a job starts. If the first job is still running when another candidate time arrives, or Catch-Up submits several candidates together, this limit alone does not guarantee a single launch. See [condition meanings](data.md#action-condition).
- **The daily counter follows the server's statistics reset.** By default this is midnight in the conductor process's timezone, not each trigger's timezone. Make sure the candidate runs and their completions fall within the intended statistics day.
- **Manual runs bypass this limit.** Runs initiated manually by a user or API key can exceed the cap.

The same pattern works for [Workflows](workflows.md). You can define the limit on a category so its events inherit the rule; the daily count is still tracked separately for each event.

### Solution 4: Write a Custom Trigger Plugin

A [Trigger Plugin](plugins.md#trigger-plugins) lets you define your own policy for ambiguous or missing local times. It is consulted at each scheduled opportunity and returns a launch decision. Give it a schedule that includes the candidate times your policy needs to consider.

Here is a small Node.js example with a specific policy for `Europe/Berlin`:

- Normally, run at 02:30.
- On fall-back day, use the first 02:30 and skip the second.
- On spring-forward day, use 03:30 because 02:30 does not exist.

Create a **Trigger Plugin**, set its command to `node`, and paste this into its script field. On the event, add a Schedule trigger with hours `2` and `3` selected, minute `30`, and timezone `Europe/Berlin`, then add a Plugin modifier selecting your plugin. No additional Node.js packages are needed.

This gives the plugin two candidates on a normal day, three on fall-back day (both occurrences of 02:30, plus 03:30), and one on spring-forward day (03:30). The plugin calculates the earlier clock reading from each candidate's timestamp, so it does not need to run during the intervening minutes. This also keeps the dashboard's **Upcoming Jobs** table focused on these candidate times. That table predicts the schedule without consulting Trigger Plugins, so it may still show candidates that the plugin will skip.

```js
const clock = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Berlin',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23'
});

async function main() {
	// Read the batch of candidate launches from xyOps.
	const chunks = [];
	for await (const chunk of process.stdin) { chunks.push(chunk); }
	const data = JSON.parse(chunks.join(''));
	
	const items = data.items.map(function(item) {
		// Use the scheduled instant, which may be historical during Catch-Up.
		const current = clock.format(new Date(item.now * 1000));
		const previous = clock.format(new Date((item.now - 3600) * 1000));
		
		// A second 02:30 has another 02:30 exactly one real hour before it.
		if (current == '02:30') return previous != '02:30';
		
		// On spring-forward day, one real hour before 03:30 was 01:30.
		return (current == '03:30') && (previous == '01:30');
	});
	
	// Return one decision per input item, preserving the original order.
	process.stdout.write(JSON.stringify({ xy: 1, items }) + '\n');
}

main().catch(function(err) {
	console.error(err);
	process.exitCode = 1;
});
```

This example is intentionally specific to Berlin's current one-hour transitions and a 02:30 target. Adapt the policy before using a different timezone or time. It needs no stored state because it distinguishes the two occurrences using their actual timestamps. It decides when to launch; it does not retry a failed job or ensure that the job completes successfully.

### Solution 5: Use a Fixed Interval

If the requirement is "every 60 minutes" or "every 24 hours," use an [Interval](triggers.md#interval) trigger. Intervals advance from an absolute starting timestamp by a fixed number of seconds, so DST does not change the spacing.

For example, an interval of `3600` seconds runs every real hour. An interval of `86400` seconds runs every 24 hours, but its displayed local time shifts when DST changes. Choose a local Schedule trigger instead if the requirement is "at the same local clock time every day."

## More Recipes

Check out more recipes in the xyOps Wiki:

https://github.com/pixlcore/xyops/wiki
