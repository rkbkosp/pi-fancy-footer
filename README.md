# ✨ pi-fancy-footer

A [pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent)
extension that replaces the default footer with a compact, two-line fancy status
footer.

<!-- markdownlint-disable MD033 -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/editor-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="screenshots/editor-light.png">
  <img alt="Pi editor with the fancy footer" src="screenshots/editor-light.png">
</picture>

<!-- markdownlint-enable MD033 -->

## 🚀 Installation

```sh
pi install npm:pi-fancy-footer
```

## 📊 What it shows

- Active model + thinking level
- Provider quota status for OpenAI Codex and Claude models, plus declarative API balances and quota windows
- A mini gauge of used context, which can optionally grow into a
  full-width bar, plus an optional context-capacity widget (hidden by
  default)
- Total session cost
- Prompt-cache statistics: cumulative cache-read/write tokens and the latest
  turn's cache hit rate
- Repo / path, branch, optional commit SHA (hidden by default), open PR
  number, unresolved PR review threads, and PR CI status
- Git diff stats and ahead/behind status

## 📸 Configuration editor

<!-- markdownlint-disable MD033 -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/config-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="screenshots/config-light.png">
  <img alt="Fancy Footer configuration editor" src="screenshots/config-light.png">
</picture>

<!-- markdownlint-enable MD033 -->

## 🎮 Commands

- `/fancy-footer` - open interactive footer config editor (small TUI)
  - widgets appear as a micro-view of the footer: same rows, alignment
    groups, and ordering as the real footer, which updates live below
  - use `←→↑↓` to select a widget (shown inverted), then:
    - `l`/`r` - move it left/right; at a group edge it flows into the
      adjacent alignment group (left ↔ middle ↔ right)
    - `u`/`d` - move it up/down a row; `d` on the bottom row hides it into
      the `hidden` strip, `u` from there brings it back
    - `a` - cycle alignment (left → middle → right)
    - `f` - toggle fill (`none` ↔ `grow`)
    - `x` or Space - toggle visibility
    - Enter - open widget-specific settings (visibility, icon, icon color,
      text color, min width)
  - arrow down past the widgets to reach the General settings (refresh,
    icon family, gauge style/width/colors, default colors, and declarative
    provider enablement/order); Enter/Space cycles values
  - declarative provider credentials and request definitions remain JSON-only;
    the editor never displays secret values
- `/fancy-footer provider list` - list built-in and declarative status sources
- `/fancy-footer provider refresh [provider]` - bypass the TTL cache and refresh all matched sources or one provider
- `/fancy-footer provider test <provider>` - make a real request and report HTTP, latency, selector, and normalized-result diagnostics
- `/fancy-footer provider debug <provider>` - show redacted source, cache, endpoint-host, and snapshot diagnostics

## ⚙️ Configuration

Create `~/.pi/agent/fancy-footer.json`:

```json
{
  "refreshMs": 3000,
  "iconFamily": "unicode",
  "gaugeStyle": "blocks",
  "gaugeWidth": 5,
  "gaugeColors": {
    "ok": "accent",
    "warning": "warning",
    "error": "error"
  },
  "defaultTextColor": "dim",
  "defaultIconColor": "text",
  "providerStatus": {
    "refreshMs": 60000,
    "cacheTtlMs": 60000,
    "providers": ["openai-codex", "anthropic"],
    "display": "gauge",
    "showCredits": false,
    "showReset": false
  },
  "widgets": {
    "context-bar": {
      "align": "left",
      "row": 0,
      "position": 0,
      "fill": "grow"
    },
    "total-cost": {
      "enabled": false
    },
    "commit": {
      "enabled": true
    },
    "branch": {
      "icon": "hide",
      "textColor": "muted"
    }
  },
  "extensionWidgets": {
    "acme.build-status": {
      "row": 1,
      "position": 8,
      "align": "right"
    }
  }
}
```

Top-level settings:

> [!NOTE]
> `fancy-footer.json` is validated strictly. Use only the documented keys and values.
> Invalid config falls back to defaults and logs a warning.

- `refreshMs` (number)
- `iconFamily`
  (`nerd` | `emoji` | `unicode` | `ascii`)
- `gaugeStyle`
  (`blocks` | `lines` | `circles` | `parallelograms` | `diamonds` | `bars` |
  `stars` | `specks`)
- `gaugeWidth` - cells spanned by the provider status gauges and the compact
  context gauge (3-40, default 5); a context bar with `fill` set to `grow`
  spans the row instead
- `gaugeColors` - fill colors per gauge severity; each of `ok`, `warning`,
  and `error` accepts a widget color. Defaults to `accent` / `warning` /
  `error`, so healthy gauges blend into the theme and only stand out when
  running low
- `defaultTextColor`
  (`text` | `accent` | `muted` | `dim` | `success` | `error` | `warning`)
- `defaultIconColor`
  (`text` | `accent` | `muted` | `dim` | `success` | `error` | `warning`)
- `providerStatus`:
  - `refreshMs` - provider status refresh interval in milliseconds
  - `cacheTtlMs` - cache freshness window in milliseconds
  - `providers` - supported provider adapters (`openai-codex`, `anthropic`)
  - `display` - render quota windows as a mini `gauge` (default) or plain
    `text`
  - `showCredits` - include provider balances and credit metrics when available
  - `showReset` - include the primary reset time when available
  - `customProviders` - declarative HTTP providers keyed by a stable provider ID

### Declarative balance and quota providers

Custom providers can query JSON APIs without extension code. The configuration key is matched against the active Pi provider ID; use `matchProviders` when they differ. Set `alwaysRefresh` only for providers that should refresh regardless of the active model.

```json
{
  "providerStatus": {
    "showCredits": true,
    "showReset": true,
    "customProviders": {
      "zero": {
        "label": "0-0",
        "matchProviders": ["zero-proxy"],
        "request": {
          "url": "https://api.example.com/api/user/self",
          "method": "GET",
          "headers": {
            "Authorization": "Bearer $ZERO_API_KEY"
          },
          "timeoutMs": 5000,
          "maxResponseBytes": 1048576,
          "followRedirects": false
        },
        "balances": [
          {
            "id": "remaining",
            "selector": "data.quota",
            "transform": {
              "scale": 0.000002,
              "round": 2
            },
            "currency": "CNY"
          }
        ],
        "windows": [
          {
            "id": "monthly",
            "label": "month",
            "usedPercentSelector": "data.monthly.used_percent",
            "resetAtSelector": "data.monthly.reset_at",
            "timestampUnit": "seconds"
          }
        ]
      }
    }
  }
}
```

Selectors support object paths and array indexes, for example `data.quota` and `data.items[0].remaining`. Numeric transforms run in this order: `scale`, `offset`, `invertPercent`, `clamp`, then `round`. A quota window can select percentages or absolute `remaining`, `used`, and `limit` values and can set a unit such as `tokens` or `requests`.

Requests support `GET` and JSON `POST` bodies. `$ENV_VAR` and `${ENV_VAR}` references are resolved in URLs, headers, and body strings. Missing variables are configuration errors. Responses must be JSON, are limited to 1 MiB by default, and time out after 5 seconds by default. Redirects are disabled unless explicitly enabled; authorization and cookie headers are removed when a redirect changes hosts. Raw responses and request credentials are never cached.

### Remote model pricing

Estimate-only pricing reads model rates from a separate JSON API and recalculates the current session cost without changing Pi's provider definitions. Estimated totals use an `≈` marker and do not rewrite historical session messages or `~/.pi/agent/models.json`.

```json
{
  "pricing": {
    "mode": "estimate-only",
    "request": {
      "url": "https://api.example.com/v1/prices",
      "headers": {
        "Authorization": "Bearer $PRICING_API_KEY"
      }
    },
    "modelsSelector": "data.models",
    "fields": {
      "id": "name",
      "input": "input_price",
      "output": "output_price",
      "cacheRead": "cache_read_price",
      "cacheWrite": "cache_write_price"
    },
    "currency": "USD",
    "unit": "per_million_tokens",
    "refreshMs": 43200000,
    "cacheTtlMs": 86400000
  }
}
```

`modelsSelector` must select an array. Field selectors are evaluated relative to each array item. Set `unit` to `per_token` when the API returns per-token rates; values are normalized to Pi's per-million-token convention. The optional numeric `transform` uses the same scale/offset/invert/clamp/round pipeline as provider resources.

Pricing has its own low-frequency cache and refresh timer. A network or parsing failure falls back to the pricing disk cache and never prevents Pi from starting. Balance and quota refreshes continue independently.

Supported per-widget overrides for both `widgets` and `extensionWidgets`:

- `enabled` (boolean)
- `row` (number)
- `position` (number, ordering within an aligned row group)
- `align` (`left` | `middle` | `right`)
- `fill` (`none` | `grow`)
- `minWidth` (number)
- `icon` (`default` | `hide`)
- `iconColor`
  (`text` | `accent` | `muted` | `dim` | `success` | `error` | `warning`)
- `textColor`
  (`text` | `accent` | `muted` | `dim` | `success` | `error` | `warning`)

Built-in widget IDs:

- `model`
- `thinking`
- `context-capacity`
- `context-bar`
- `total-cost`
- `cache-read`
- `cache-write`
- `cache-hit-rate`
- `location`
- `branch`
- `commit`
- `pull-request`
- `pull-request-review-threads`
- `pull-request-ci-status`
- `provider-status`
- `diff-added`
- `diff-removed`
- `git-status`

3rd-party widget IDs are extension-defined and live under `extensionWidgets`.

## 🧩 Extension widgets

Other pi extensions can contribute fancy-footer widgets.

### For users

- Contributed widgets appear alongside built-in widgets in the `/fancy-footer` micro-view.
- Their overrides are stored in `extensionWidgets` inside `~/.pi/agent/fancy-footer.json`.
- They use the same layout controls as built-in widgets, so you can mix and match them on any footer row.

### For extension developers

Publish complete widget snapshots over pi's in-process event bus. Producers do
not need to depend on `pi-fancy-footer`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const protocol = 1;
const widgetChannel = "pi-fancy-footer:widget";
const readyChannel = "pi-fancy-footer:ready";

export default function (pi: ExtensionAPI) {
  let status = "passing";

  const publish = () => {
    pi.events.emit(widgetChannel, {
      protocol,
      type: "upsert",
      widget: {
        id: "acme.build-status",
        label: "Build status",
        description: "Current build result",
        content: { type: "text", text: status },
        icon: {
          glyphs: {
            nerd: "󰙨",
            emoji: "🧪",
            unicode: "◈",
            ascii: "B",
          },
          color: "success",
        },
        style: { textColor: "success" },
        layout: { row: 1, position: 8, align: "right" },
      },
    });
  };

  const stopReady = pi.events.on(readyChannel, (message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "protocol" in message &&
      message.protocol === protocol
    ) {
      publish();
    }
  });

  // Publish once for a footer that is already listening. Publish again when
  // state changes; the footer does not poll producers.
  publish();

  pi.on("session_shutdown", () => {
    stopReady();
    pi.events.emit(widgetChannel, {
      protocol,
      type: "remove",
      id: "acme.build-status",
    });
  });
}
```

The protocol uses these channels:

- `pi-fancy-footer:widget` accepts protocol-1 `upsert` and `remove` messages.
- `pi-fancy-footer:ready` announces that the footer is listening. Producers
  should republish their current snapshot when they receive it.

Each `upsert` replaces the complete snapshot for its `id`; the latest command
wins if multiple producers use the same ID. IDs must be at most 128 ASCII
characters and contain two or more dot-separated segments. Each segment starts
with a letter or digit and may also contain letters, digits, underscores, and
hyphens, for example `acme.build-status`. An empty `content.text` hides the
widget while keeping it configurable, even when the widget is explicitly
enabled. A `remove` message drops the live widget definition. Widget text is
limited to 512 Unicode code points and terminal control characters are stripped.

The structured snapshot can provide `label`, `description`, an icon glyph or
per-family glyph map, icon and text colors, and layout defaults (`enabled`,
`row`, `position`, `align`, `fill`, and `minWidth`). Saved user settings override
event-provided defaults. Use `layout.enabled: false` for an opt-in widget.

Extensions that already depend on this package may use
`createFancyFooterClient` from `pi-fancy-footer/api` for typed `upsert`,
`remove`, and `onReady` helpers. It speaks the same event protocol.

## 🔣 Icon families

The following table shows the symbol used by each widget for each icon family.
For `git-status`, the table shows the rendered status symbols rather than a
leading widget icon.

> [!NOTE]
> Some glyphs, especially in the `nerd` family, may not render in your browser.
> If a cell looks blank or shows a replacement box, check the table in a
> terminal with the relevant font installed.

<!-- markdownlint-disable MD013 MD060 -->

| Widget                        | nerd    | emoji      | unicode  | ascii    |
| ----------------------------- | ------- | ---------- | -------- | -------- |
| `context-bar`                 | `󰾆`     | `🔋`       | `◧`      | `\|`     |
| `context-capacity`            | ``     | `💾`       | `□`      | `[]`     |
| `provider-status`             | `󰓅`     | `📊`       | `%`      | `%`      |
| `cache-read`                  | `󰇚`     | `📥`       | `↧`      | `R`      |
| `cache-write`                 | `󰕒`     | `📤`       | `↥`      | `W`      |
| `cache-hit-rate`              | `󰀚`     | `🎯`       | `◎`      | `H`      |
| `total-cost`                  | `󰇁`     | `💲`       | `$`      | `$`      |
| `location`                    | ``     | `📁`       | `⌂`      | `/`      |
| `branch`                      | ``     | `🌿`       | `⎇`      | `*`      |
| `commit`                      | ``     | `🔖`       | `#`      | `#`      |
| `pull-request`                | ``     | `🔀`       | `⇄`      | `@`      |
| `pull-request-review-threads` | `󰅺`     | `💬`       | `✎`      | `!`      |
| `pull-request-ci-status`      | `//` | `⏳/❌/✅` | `◷/✕/✓`  | `~/x/+`  |
| `diff-added`                  | `↗`    | `➕`       | `+`      | `+`      |
| `diff-removed`                | `↘`    | `➖`       | `−`      | `-`      |
| `git-status`                  | `//` | `🔼/🔽/🔀` | `↑/↓/↕` | `^/_/<>` |
| `model`                       | `󰚩`     | `🤖`       | `◉`      | `%`      |
| `thinking`                    | `󰧑`     | `🧠`       | `✦`      | `?`      |

<!-- markdownlint-enable MD013 MD060 -->

Notes:

- Most widgets use a leading icon.
- `context-bar` renders a battery-style mini gauge of used context,
  e.g. `■■□□□ 40%`, spanning `gaugeWidth` cells with the glyphs from
  `gaugeStyle` (not `iconFamily`). Filled cells and the percentage show the
  consumed share, colored via `gaugeColors` by how close the context is to
  exhaustion; empty cells stay dim. It sits on the left of the top row by
  default, with provider quota gauges beside it. Set the widget's `fill` to
  `grow` (via `/fancy-footer` or the configuration file) to expand it into a
  full-width bar with the used tokens in front, e.g. `246k ██████████░░░`.
- `context-capacity` shows the total context window in compact SI form
  (`200k`, `1M`). It is hidden by default since the context bar already
  conveys usage; enable it via `/fancy-footer` (it starts in the `hidden`
  strip) or with `"context-capacity": { "enabled": true }`. It then sits
  between the context bar and the provider quota gauges.
- `commit` shows the short Git commit SHA. It is hidden by default; enable it
  via `/fancy-footer` or with `"commit": { "enabled": true }`.
- `cache-read` and `cache-write` show cumulative prompt-cache tokens for the
  session in compact form (e.g. `246k`, `1.2M`). `cache-hit-rate` shows the
  latest turn's cache hit rate, computed as
  `cacheRead / (input + cacheRead + cacheWrite)`, matching the `R` / `W` /
  `CH` stats in pi's built-in footer. All three sit on the right of the top
  row by default, before `total-cost` (which stays rightmost), and hide when
  the session has no cache activity or the terminal is narrower than 60
  columns.
- `git-status` uses symbols for ahead / behind / diverged status.
- `pull-request-ci-status` is icon-only and uses symbols for running / failed /
  okay status. By default it uses semantic colors (warning / error / success);
  set this widget's icon color to override them.
- `provider-status` shows provider quota windows for OpenAI Codex and Claude
  models as battery-style mini gauges per window, e.g.
  `5h ▰▰▰▰▱ 80% 7d ▰▰▱▱▱ 38%`,
  where filled cells show the remaining quota and each window is colored by
  how close it is to exhaustion. The gauge spans `gaugeWidth` cells and
  reuses the configured `gaugeStyle` glyphs; set `providerStatus.display` to
  `text` for the compact `5h:95% 7d:97%` form. The widget renders only the
  windows that the provider reports. If Codex omits its 5-hour window and
  promotes the weekly window to primary, the footer removes the stale 5-hour
  value and shows only `7d`. In an output such as
  `󰾆▱▱▱▱▱ 0% 󰓅7d ▰▰▰▰▱ 84%`, `0%` is the share of pi's context window in
  use and `84%` is the remaining weekly Codex quota. Codex uses existing pi
  OpenAI Codex credentials
  from `~/.pi/agent/auth.json`, falling back to Codex CLI credentials in
  `~/.codex/auth.json`. Claude uses pi Anthropic OAuth credentials from
  `~/.pi/agent/auth.json` and reads Claude.ai usage for the 5-hour and weekly
  windows. Status is cached under `~/.cache/pi-fancy-footer/provider-status/`;
  when a refresh fails, cached quota windows keep showing until their reset times
  pass instead of hiding the widget. The widget is hidden when the active model
  selection is not backed by the status provider.
- `provider-status` also refreshes from `x-codex-*` provider response headers
  when pi exposes them, avoiding a separate Codex status request after provider
  calls. Claude status refreshes from the Claude.ai usage endpoint, not
  provider response headers.
- `iconFamily` lets you choose between `nerd`, `emoji`, `unicode`, and
  `ascii` palettes.
- `nerd` keeps the original Nerd Font look. `emoji`, `unicode`, and `ascii`
  work better in terminals that don't use a Nerd Font.
- Per-widget icon overrides only let you hide the icon. The selected
  `iconFamily` controls which icon each widget uses.
- The PR widgets appear only for open GitHub and GitHub Enterprise pull
  requests on GitHub-style hosts such as `github.example.com`; they rely on the
  GitHub CLI (`gh`) being available and authenticated for the remote host.
- `pull-request-review-threads` counts unresolved GitHub review threads
  on the current PR.
- `pull-request-ci-status` shows GitHub Actions workflow runs for the current
  PR head commit. It links to the relevant run and switches to failed as soon as
  one workflow fails, even when other workflows are still running.

## 🧱 Gauge styles

The `gaugeStyle` setting controls the characters used by the `context-bar`
and `provider-status` gauges. Each style defines symbols for filled and empty
cells:

<!-- markdownlint-disable MD013 MD060 -->

| Style              | Filled | Empty |
| ------------------ | ------ | ----- |
| `blocks` (default) | `■`    | `□`   |
| `lines`            | `━`    | `─`   |
| `circles`          | `●`    | `○`   |
| `parallelograms`   | `▰`    | `▱`   |
| `diamonds`         | `◆`    | `◇`   |
| `bars`             | `█`    | `░`   |
| `stars`            | `★`    | `☆`   |
| `specks`           | `•`    | `◦`   |

<!-- markdownlint-enable MD013 MD060 -->

## 🧹 Uninstall

```sh
pi remove npm:pi-fancy-footer
```

## 📄 License

[MIT](LICENSE)
