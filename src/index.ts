import { createRequire } from "node:module";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FOOTER_CONFIG,
  EMPTY_GIT_INFO,
  MAX_FOOTER_REFRESH_MS,
  MAX_PROVIDER_STATUS_REFRESH_MS,
  MIN_FOOTER_REFRESH_MS,
  MIN_PROVIDER_STATUS_REFRESH_MS,
  clampInt,
  type FooterConfigSnapshot,
  type ProviderStatusSnapshot,
  type SessionUsageMetrics,
} from "./shared.ts";
import {
  cloneFooterConfig,
  getFooterConfigPath,
  loadFooterConfig,
  writeFooterConfigSnapshot,
} from "./config.ts";
import {
  collectGitInfo,
  collectPullRequestInfo,
  shouldRefreshPullRequest,
} from "./git.ts";
import {
  FANCY_FOOTER_PROTOCOL_VERSION,
  FANCY_FOOTER_READY_CHANNEL,
  FANCY_FOOTER_WIDGET_CHANNEL,
  type FancyFooterReadyMessage,
} from "./api.ts";
import {
  createMicrotaskCoalescer,
  FancyFooterDataWidgetStore,
  type NormalizedFancyFooterDataWidget,
} from "./data-widgets.ts";
import { openFooterConfigEditor } from "./config-editor.ts";
import { collectSessionUsageMetrics, renderFooterLines } from "./render.ts";
import {
  collectProviderStatus,
  updateProviderStatusFromHeaders,
} from "./provider-status.ts";
import {
  debugProviderStatusSource,
  listProviderStatusSources,
  testProviderStatusSource,
} from "./provider-status/diagnostics.ts";
import { redactSensitiveText } from "./provider-status/redact.ts";
import {
  DEFAULT_PRICING_REFRESH_MS,
  estimateSessionCost,
  loadPricingCatalog,
  registerProviderWithPricing,
  type PricingCatalog,
} from "./pricing/index.ts";

interface ActiveFooterControls {
  requestRender: () => void;
  reschedule: () => void;
  rescheduleProviderStatus: () => void;
  reschedulePricing: () => void;
  refreshProviderStatus: (force?: boolean) => void;
  refreshUsage: () => void;
  replaceProviderStatuses: (statuses: ProviderStatusSnapshot[]) => void;
  updateProviderStatus: (status: ProviderStatusSnapshot) => void;
}

const PACKAGE_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

export default async function (pi: ExtensionAPI) {
  let footerConfig: FooterConfigSnapshot = {
    refreshMs: DEFAULT_FOOTER_CONFIG.refreshMs,
    iconFamily: DEFAULT_FOOTER_CONFIG.iconFamily,
    gaugeStyle: DEFAULT_FOOTER_CONFIG.gaugeStyle,
    gaugeWidth: DEFAULT_FOOTER_CONFIG.gaugeWidth,
    gaugeColors: { ...DEFAULT_FOOTER_CONFIG.gaugeColors },
    defaultTextColor: DEFAULT_FOOTER_CONFIG.defaultTextColor,
    defaultIconColor: DEFAULT_FOOTER_CONFIG.defaultIconColor,
    providerStatus: {
      ...DEFAULT_FOOTER_CONFIG.providerStatus,
      customProviders: structuredClone(
        DEFAULT_FOOTER_CONFIG.providerStatus.customProviders,
      ),
    },
    widgets: { ...DEFAULT_FOOTER_CONFIG.widgets },
    extensionWidgets: { ...DEFAULT_FOOTER_CONFIG.extensionWidgets },
  };
  let registeredPricingProviderId: string | undefined;
  const applyPricingRegistration = (
    config: FooterConfigSnapshot["pricing"],
    catalog?: PricingCatalog,
  ) => {
    const nextProviderId =
      config?.mode === "register-provider"
        ? config.registration?.id
        : undefined;
    if (
      registeredPricingProviderId &&
      registeredPricingProviderId !== nextProviderId
    ) {
      pi.unregisterProvider(registeredPricingProviderId);
      registeredPricingProviderId = undefined;
    }
    if (!config || config.mode !== "register-provider") return;
    try {
      if (registerProviderWithPricing(pi, config, catalog)) {
        registeredPricingProviderId = config.registration?.id;
      }
    } catch (error) {
      console.warn(
        `Failed to register pricing provider: ${redactSensitiveText(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  };

  const startupConfig = loadFooterConfig();
  let startupPricingCatalog: PricingCatalog | undefined;
  if (startupConfig.pricing?.mode === "register-provider") {
    startupPricingCatalog = await loadPricingCatalog(startupConfig.pricing);
    applyPricingRegistration(startupConfig.pricing, startupPricingCatalog);
  }

  const dataWidgets = new FancyFooterDataWidgetStore();
  let extensionWidgets: NormalizedFancyFooterDataWidget[] = [];

  let activeFooterControls: ActiveFooterControls | undefined;
  let footerInstanceId = 0;

  const invalidateActiveFooter = () => {
    footerInstanceId += 1;
    activeFooterControls = undefined;
  };

  const requestDataWidgetRender = createMicrotaskCoalescer(() => {
    activeFooterControls?.requestRender();
  });
  const refreshDataWidgets = () => {
    extensionWidgets = dataWidgets.values();
    requestDataWidgetRender();
  };
  const publishReady = () => {
    const message: FancyFooterReadyMessage = {
      protocol: FANCY_FOOTER_PROTOCOL_VERSION,
      version: PACKAGE_VERSION,
    };
    pi.events.emit(FANCY_FOOTER_READY_CHANNEL, message);
  };

  const stopDataWidgetListener = pi.events.on(
    FANCY_FOOTER_WIDGET_CHANNEL,
    (raw) => {
      if (dataWidgets.apply(raw)) refreshDataWidgets();
    },
  );

  const installFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    footerConfig = loadFooterConfig();

    ctx.ui.setFooter((tui, theme, footerData) => {
      const instanceId = ++footerInstanceId;
      const fallbackThinkingLevel = pi.getThinkingLevel();
      let currentGit = { ...EMPTY_GIT_INFO };
      let providerStatuses = new Map<string, ProviderStatusSnapshot>();
      let pricingCatalog: PricingCatalog | undefined = startupPricingCatalog;
      const collectUsage = (): SessionUsageMetrics => {
        const metrics = collectSessionUsageMetrics(ctx);
        if (footerConfig.pricing?.mode !== "estimate-only" || !pricingCatalog) {
          return metrics;
        }
        const estimated = estimateSessionCost(
          ctx.sessionManager.getBranch(),
          pricingCatalog,
          ctx.model?.id,
          ctx.model?.provider,
          footerConfig.pricing.matchProviders,
        );
        return estimated === undefined
          ? metrics
          : {
              ...metrics,
              totalCost: estimated,
              totalCostApproximate: true,
            };
      };
      let usageMetrics: SessionUsageMetrics = collectUsage();
      let refreshing = false;
      let refreshQueued = false;
      let pullRequestRefreshing = false;
      let pullRequestRefreshQueued = false;
      let providerStatusRefreshing = false;
      let providerStatusRefreshQueued = false;
      let providerStatusRefreshAt = 0;
      let disposed = false;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let providerStatusTimer: ReturnType<typeof setTimeout> | undefined;
      let pricingTimer: ReturnType<typeof setTimeout> | undefined;

      const isActiveFooter = () => !disposed && instanceId === footerInstanceId;

      const requestRender = () => {
        if (!isActiveFooter()) return;
        tui.requestRender();
      };

      const isPullRequestReviewThreadsWidgetEnabled = () => {
        const widget = footerConfig.widgets["pull-request-review-threads"];
        return widget?.enabled !== false;
      };

      const isPullRequestCiStatusWidgetEnabled = () => {
        const widget = footerConfig.widgets["pull-request-ci-status"];
        return widget?.enabled !== false;
      };

      const isPullRequestBackedWidgetEnabled = () =>
        footerConfig.widgets["pull-request"]?.enabled !== false ||
        isPullRequestReviewThreadsWidgetEnabled() ||
        isPullRequestCiStatusWidgetEnabled();

      const isProviderStatusWidgetEnabled = () =>
        footerConfig.widgets["provider-status"]?.enabled !== false;

      const refreshProviderStatus = async (force = false) => {
        if (!isActiveFooter() || !isProviderStatusWidgetEnabled()) return;
        const now = Date.now();
        const refreshMs = clampInt(
          footerConfig.providerStatus.refreshMs,
          MIN_PROVIDER_STATUS_REFRESH_MS,
          MAX_PROVIDER_STATUS_REFRESH_MS,
        );
        if (!force && providerStatusRefreshAt + refreshMs > now) return;
        if (providerStatusRefreshing) {
          providerStatusRefreshQueued = true;
          return;
        }

        providerStatusRefreshing = true;
        try {
          do {
            providerStatusRefreshQueued = false;
            if (!isActiveFooter() || !isProviderStatusWidgetEnabled()) {
              continue;
            }

            providerStatusRefreshAt = Date.now();
            const next = await collectProviderStatus(
              pi,
              footerConfig.providerStatus,
              ctx.model,
            );
            if (!isActiveFooter()) return;
            providerStatuses = new Map(
              next.map((snapshot) => [snapshot.provider, snapshot]),
            );
            requestRender();
          } while (isActiveFooter() && providerStatusRefreshQueued);
        } finally {
          providerStatusRefreshing = false;
        }
      };

      // Keep networked PR discovery off the local git refresh path.
      const refreshPullRequest = async () => {
        if (
          !isActiveFooter() ||
          !isPullRequestBackedWidgetEnabled() ||
          !shouldRefreshPullRequest(currentGit)
        ) {
          return;
        }
        if (pullRequestRefreshing) {
          pullRequestRefreshQueued = true;
          return;
        }

        pullRequestRefreshing = true;
        try {
          do {
            pullRequestRefreshQueued = false;

            if (
              !isActiveFooter() ||
              !isPullRequestBackedWidgetEnabled() ||
              !shouldRefreshPullRequest(currentGit)
            ) {
              continue;
            }

            const targetBranch = currentGit.branch;
            const targetRepository = currentGit.repository;
            const targetLookupAt = currentGit.pullRequestLookupAt;
            const pullRequest = await collectPullRequestInfo(
              pi,
              ctx.cwd,
              targetBranch,
              {
                includeReviewThreads: isPullRequestReviewThreadsWidgetEnabled(),
                includeCiStatus: isPullRequestCiStatusWidgetEnabled(),
              },
            );
            if (!isActiveFooter()) return;
            if (
              currentGit.branch !== targetBranch ||
              currentGit.repository !== targetRepository ||
              currentGit.pullRequestLookupAt !== targetLookupAt
            ) {
              continue;
            }

            currentGit = {
              ...currentGit,
              ...pullRequest,
            };
            requestRender();
          } while (isActiveFooter() && pullRequestRefreshQueued);
        } finally {
          pullRequestRefreshing = false;
        }
      };

      const refreshGit = async () => {
        if (!isActiveFooter()) return;
        if (refreshing) {
          refreshQueued = true;
          return;
        }

        refreshing = true;
        try {
          do {
            refreshQueued = false;
            if (!isActiveFooter()) continue;

            footerConfig = loadFooterConfig();
            usageMetrics = collectUsage();

            const git = await collectGitInfo(pi, ctx.cwd, currentGit);
            if (!isActiveFooter()) return;
            currentGit = git;
            requestRender();
            void refreshPullRequest();
          } while (isActiveFooter() && refreshQueued);
        } finally {
          refreshing = false;
        }
      };

      const scheduleRefresh = () => {
        if (!isActiveFooter()) return;
        if (refreshTimer) clearTimeout(refreshTimer);

        const refreshMs = clampInt(
          footerConfig.refreshMs,
          MIN_FOOTER_REFRESH_MS,
          MAX_FOOTER_REFRESH_MS,
        );
        refreshTimer = setTimeout(() => {
          if (!isActiveFooter()) return;
          void refreshGit().finally(() => {
            scheduleRefresh();
          });
        }, refreshMs);
      };

      const scheduleProviderStatusRefresh = () => {
        if (!isActiveFooter()) return;
        if (providerStatusTimer) clearTimeout(providerStatusTimer);

        const refreshMs = clampInt(
          footerConfig.providerStatus.refreshMs,
          MIN_PROVIDER_STATUS_REFRESH_MS,
          MAX_PROVIDER_STATUS_REFRESH_MS,
        );
        providerStatusTimer = setTimeout(() => {
          if (!isActiveFooter()) return;
          void refreshProviderStatus().finally(() => {
            scheduleProviderStatusRefresh();
          });
        }, refreshMs);
      };

      const refreshPricing = async (force = false) => {
        if (!isActiveFooter()) return;
        const pricing = footerConfig.pricing;
        if (!pricing) {
          pricingCatalog = undefined;
          applyPricingRegistration(undefined);
          usageMetrics = collectUsage();
          requestRender();
          return;
        }
        const catalog = await loadPricingCatalog(pricing, { force });
        if (!isActiveFooter()) return;
        pricingCatalog = catalog;
        applyPricingRegistration(pricing, catalog);
        usageMetrics = collectUsage();
        requestRender();
      };

      const schedulePricingRefresh = () => {
        if (!isActiveFooter()) return;
        if (pricingTimer) clearTimeout(pricingTimer);
        const pricing = footerConfig.pricing;
        if (!pricing) return;
        pricingTimer = setTimeout(() => {
          if (!isActiveFooter()) return;
          void refreshPricing(true).finally(() => schedulePricingRefresh());
        }, pricing.refreshMs ?? DEFAULT_PRICING_REFRESH_MS);
      };

      const onBranchChange = footerData.onBranchChange(() => {
        if (!isActiveFooter()) return;
        usageMetrics = collectUsage();
        requestRender();
        void refreshGit();
      });

      activeFooterControls = {
        requestRender,
        reschedule: scheduleRefresh,
        rescheduleProviderStatus: scheduleProviderStatusRefresh,
        reschedulePricing: schedulePricingRefresh,
        refreshProviderStatus: (force = false) => {
          void refreshProviderStatus(force);
        },
        refreshUsage: () => {
          if (!isActiveFooter()) return;
          usageMetrics = collectUsage();
          requestRender();
        },
        replaceProviderStatuses: (statuses) => {
          if (!isActiveFooter()) return;
          providerStatuses = new Map(
            statuses.map((snapshot) => [snapshot.provider, snapshot]),
          );
          requestRender();
        },
        updateProviderStatus: (status) => {
          if (!isActiveFooter()) return;
          providerStatuses.set(status.provider, status);
          requestRender();
        },
      };

      void refreshGit();
      void refreshProviderStatus(true);
      void refreshPricing();
      scheduleRefresh();
      scheduleProviderStatusRefresh();
      schedulePricingRefresh();

      return {
        invalidate() {},
        dispose() {
          disposed = true;
          onBranchChange();
          if (refreshTimer) clearTimeout(refreshTimer);
          if (providerStatusTimer) clearTimeout(providerStatusTimer);
          if (pricingTimer) clearTimeout(pricingTimer);
          if (activeFooterControls?.requestRender === requestRender) {
            activeFooterControls = undefined;
          }
        },
        render(width: number): string[] {
          if (!isActiveFooter()) return ["", ""];

          return renderFooterLines(
            width,
            ctx,
            currentGit,
            fallbackThinkingLevel,
            theme,
            usageMetrics,
            footerConfig,
            extensionWidgets,
            Array.from(providerStatuses.values()).sort((a, b) =>
              a.provider.localeCompare(b.provider),
            ),
            footerData.getExtensionStatuses(),
          );
        },
      };
    });
  };

  pi.registerCommand("fancy-footer", {
    description: "Configure the footer or inspect provider status.",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "provider") {
        const action = parts[1] ?? "list";
        const providerId = parts[2];
        footerConfig = loadFooterConfig();
        try {
          if (action === "list" && !providerId) {
            ctx.ui.notify(
              listProviderStatusSources(
                footerConfig.providerStatus,
                ctx.model,
              ).join("\n"),
              "info",
            );
            return;
          }
          if (action === "refresh" && parts.length <= 3) {
            const statuses = await collectProviderStatus(
              pi,
              footerConfig.providerStatus,
              ctx.model,
              { providerId, force: true, signal: ctx.signal },
            );
            if (providerId && statuses.length === 0) {
              throw new Error(`Unknown or disabled provider: ${providerId}`);
            }
            if (providerId) {
              for (const status of statuses) {
                activeFooterControls?.updateProviderStatus(status);
              }
            } else {
              activeFooterControls?.replaceProviderStatuses(statuses);
            }
            ctx.ui.notify(
              providerId
                ? `Refreshed provider ${providerId}`
                : `Refreshed ${statuses.length} provider status source(s)`,
              "info",
            );
            return;
          }
          if (action === "test" && providerId && parts.length === 3) {
            const lines = await testProviderStatusSource(
              pi,
              footerConfig.providerStatus,
              providerId,
              ctx.signal,
            );
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          if (action === "debug" && providerId && parts.length === 3) {
            const lines = await debugProviderStatusSource(
              footerConfig.providerStatus,
              providerId,
            );
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          ctx.ui.notify(
            "Usage: /fancy-footer provider list|refresh [provider]|test <provider>|debug <provider>",
            "warning",
          );
        } catch (error) {
          const message = redactSensitiveText(
            error instanceof Error ? error.message : String(error),
          );
          ctx.ui.notify(`Provider command failed: ${message}`, "error");
        }
        return;
      }

      const configPath = getFooterConfigPath();
      if (!ctx.hasUI) {
        ctx.ui.notify("/fancy-footer requires interactive UI mode", "warning");
        return;
      }

      const draft = cloneFooterConfig(loadFooterConfig());
      const applyDraft = () => {
        try {
          writeFooterConfigSnapshot(draft);
          footerConfig = loadFooterConfig();
          activeFooterControls?.reschedule();
          activeFooterControls?.rescheduleProviderStatus();
          activeFooterControls?.reschedulePricing();
          activeFooterControls?.requestRender();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to save config: ${msg}`, "error");
        }
      };

      await openFooterConfigEditor({
        ctx,
        configPath,
        draft,
        extensionWidgets,
        applyDraft,
      });
    },
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (footerConfig.widgets["provider-status"]?.enabled === false) return;

    const updated = await updateProviderStatusFromHeaders(
      event.headers ?? {},
      footerConfig.providerStatus,
      ctx.model,
    );
    for (const snapshot of updated) {
      activeFooterControls?.updateProviderStatus(snapshot);
    }
    activeFooterControls?.refreshProviderStatus();
  });

  pi.on("model_select", async () => {
    activeFooterControls?.refreshProviderStatus(true);
    activeFooterControls?.refreshUsage();
  });

  pi.on("turn_end", async () => {
    activeFooterControls?.refreshUsage();
  });

  pi.on("session_shutdown", async () => {
    if (registeredPricingProviderId) {
      pi.unregisterProvider(registeredPricingProviderId);
      registeredPricingProviderId = undefined;
    }
    stopDataWidgetListener();
    invalidateActiveFooter();
    if (dataWidgets.clear()) extensionWidgets = [];
  });

  pi.on("session_start", async (_event, ctx) => {
    if (dataWidgets.clear()) extensionWidgets = [];
    installFooter(ctx);
    publishReady();
  });

  publishReady();
}
