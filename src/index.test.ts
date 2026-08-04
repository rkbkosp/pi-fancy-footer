import assert from "node:assert/strict";
import test from "node:test";
import { FANCY_FOOTER_WIDGET_CHANNEL } from "./api.ts";
import fancyFooter from "./index.ts";

test("the provider list subcommand reports registered sources", async () => {
  let commandHandler:
    | ((args: string, ctx: unknown) => Promise<void>)
    | undefined;
  const notifications: string[] = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    registerCommand(
      _name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commandHandler = command.handler;
    },
    on() {},
  };
  fancyFooter(pi as never);
  assert.ok(commandHandler);

  await commandHandler("provider list", {
    hasUI: true,
    model: { provider: "openai", id: "gpt-5" },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });

  assert.match(notifications.join("\n"), /openai-codex\s+builtin/);
  assert.match(notifications.join("\n"), /anthropic\s+builtin/);
});

test("the data widget listener is removed during session shutdown", async () => {
  let stopCalls = 0;
  let compact: (() => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const pi = {
    events: {
      emit() {},
      on(channel: string) {
        assert.equal(channel, FANCY_FOOTER_WIDGET_CHANNEL);
        return () => {
          stopCalls += 1;
        };
      },
    },
    registerCommand() {},
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_compact") compact = handler;
      if (event === "session_shutdown") shutdown = handler;
    },
  };

  fancyFooter(pi as never);
  assert.ok(compact);
  assert.ok(shutdown);
  assert.equal(stopCalls, 0);

  await compact();
  assert.equal(stopCalls, 0);

  await shutdown();
  assert.equal(stopCalls, 1);
});
